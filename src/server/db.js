'use strict';

const redis = require('redis'),
	bluebird = require('bluebird'),
	parseCSV = require('./utils').parseCSV,
	config = require('./config');

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

let client = redis.createClient(config.redis);

class GameObject
{
	constructor(type, id)
	{
		this.type = type;
		this.properties = ['id'];
		this.propTypes = {id: 'int'};
		this.cache = {};
		this.delta = {id};
	}

	load()
	{
		let self = this;
		return new Promise((resolve,reject) =>
		{
			client.hmgetAsync(self.type+':'+self.get('id'), self.properties)
			.then(result => {
				self.properties.forEach((k,i) => {
					if(result[i] !== null)
					{
						switch(self.propTypes[k]){

						case 'csv':
							self.cache[k] = parseCSV(result[i]);
							break;
						case 'int':
						case 'bool':
						case 'json':
							self.cache[k] = JSON.parse(result[i]);
							break;
						case 'string':
						default:
							self.cache[k] = result[i];
							break;
						}
					}
				});
				if(Object.keys(self.cache).length > 0)
					self.delta = {};
				resolve(this);
			})
			.catch(err => {
				console.error(err);
				reject(err);
			});
		});
	}

	save()
	{
		let self = this;
		return new Promise((resolve,reject) =>
		{
			let dbSafe = {};
			for(let i in self.delta){
				switch(self.propTypes[i]){
					case 'csv':
						dbSafe[i] = self.delta[i].join(',');
						break;
					case 'int':
					case 'bool':
					case 'json':
						dbSafe[i] = JSON.stringify(self.delta[i]);
						break;
					case 'string':
					default:
						dbSafe[i] = self.delta[i];
				}
			}

			client.multi()
			.hmset(self.type+':'+self.get('id'), dbSafe)
			.expire(self.type+':'+self.get('id'), 60*60*24)
			.execAsync()
			.then(result => {
				console.log('save', result);
				Object.assign(self.cache, self.delta);
				resolve(self.delta);
				self.delta = {};
			})
			.catch(err => {
				console.error(err);
				reject(err);
			});
		});
	}

	discard()
	{
		self.delta = {};
	}

	get(field){
		if(this.delta[field] !== undefined)
			return this.delta[field];
		else if(this.cache[field] !== undefined)
			return this.cache[field];
	}

	set(field, val){
		if(this.cache[field] !== undefined || this.delta[field] !== undefined)
			this.delta[field] = val;
		else {
			throw new Error(`Field ${field} is not valid on this object`);
		}
	}

	serialize()
	{
		let safe = {};
		Object.assign(safe, this.cache, this.delta);
		return safe;
	}

	destroy()
	{
		let self = this;
		return new Promise((resolve,reject) =>
		{
			client.delAsync(self.type+':'+self.get('id'))
			.then(result => {
				self.delta = Object.assign({}, self.cache, self.delta);
				self.cache = {};
				resolve();
			})
			.catch(err => {
				console.error(err);
				reject(err);
			});
		});
	}
}

class GameState extends GameObject
{
	constructor(id)
	{
		super('game', id);
		let defaults = {
			state: 'setup',
			turnOrder: [], // CSV of userIds
			votesInProgress: [], // CSV of voteIds
			president: 0, // userId
			chancellor: 0, // userId
			lastPresident: 0, // userId
			lastChancellor: 0, // userId

			liberalPolicies: 0,
			fascistPolicies: 0,
			deckFascist: 11,
			deckLiberal: 6,
			discardFascist: 0,
			discardLiberal: 0,
			specialElection: false,
			failedVotes: 0
		};

		Object.assign(this.propTypes, {
			state: 'string',
			turnOrder: 'csv',
			votesInProgress: 'csv',
			president: 'int',
			chancellor: 'int',
			lastPresident: 'int',
			lastChancellor: 'int',
			liberalPolicies: 'int',
			fascistPolicies: 'int',
			deckLiberal: 'int',
			deckFascist: 'int',
			discardLiberal: 'int',
			discardFascist: 'int',
			specialElection: 'bool',
			failedVotes: 'int'
		});

		this.properties.push(...Object.keys(defaults));
		Object.assign(this.delta, defaults);
		this.players = {};
		this.votes = {};
	}

	loadPlayers()
	{
		this.get('turnOrder').forEach((e => {
			this.players[e] = new Player(e);
		}).bind(this));

		return Promise.all(
			this.get('turnOrder').map(
				(e => this.players[e].load()).bind(this)
			)
		);
	}

	serializePlayers(hideSecrets = true)
	{
		let c = {};
		for(let i in this.players){
			c[i] = this.players[i].serialize(hideSecrets);
		}
		return c;
	}

	loadVotes()
	{
		this.get('votesInProgress').forEach((e => {
			this.votes[e] = new Vote(e);
		}).bind(this));

		return Promise.all(
			this.get('votesInProgress').map(
				(e => this.votes[e].load()).bind(this)
			)
		);
	}

	serializeVotes()
	{
		let c = {};
		for(let i in this.votes){
			c[i] = this.votes[i].serialize();
		}
		return c;
	}
}

class Player extends GameObject
{
	constructor(id)
	{
		super('player', id);

		let defaults = {
			displayName: '',
			isModerator: false,
			seatNum: null,
			role: 'unassigned', // one of 'unassigned', 'hitler', 'fascist', 'liberal'
			state: 'normal', // one of 'normal', 'investigated', 'dead'
			connected: true
		};

		Object.assign(this.propTypes, {
			displayName: 'string',
			isModerator: 'bool',
			seatNum: 'int',
			role: 'string',
			state: 'string',
			connected: 'bool'
		});

		this.properties.push(...Object.keys(defaults));
		Object.assign(this.delta, defaults);
	}

	serialize(hideSecrets = true){
		let safe = super.serialize();
		if(hideSecrets) delete safe.role;
		return safe;
	}
}

class Vote extends GameObject
{
	constructor(id)
	{
		super('vote', id);

		let defaults = {
			type: 'elect', // one of 'elect', 'join', 'kick', 'reset'
			target1: 0, // userId of president/joiner/kicker
			target2: 0, // userId of chancellor
			data: '', // display name of join requester

			toPass: 1, // number of yea votes needed to pass
			requires: 1, // number of total votes before evaluation
			yesVoters: [], // CSV of userIds that voted yes
			noVoters: [], // CSV of userIds that voted no
			nonVoters: [] // CSV of userIds that are not allowed to vote
		};

		Object.assign(this.propTypes, {
			type: 'string',
			target1: 'int',
			target2: 'int',
			data: 'string',

			toPass: 'int',
			requires: 'int',
			yesVoters: 'csv',
			noVoters: 'csv',
			nonVoters: 'csv'
		});

		this.properties.push(...Object.keys(defaults));
		Object.assign(this.delta, defaults);
	}
}

exports.GameState = GameState;
exports.Player = Player;
exports.Vote = Vote;
