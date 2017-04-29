const _ = require('lodash');
const beautyError = require('smallorange-beauty-error');
const {
	Observable,
	Subject
} = require('rxjs');

module.exports = class CloudWatch {
	constructor(options) {
		if (!options.client) {
			throw new Error('no cloudwatch client provided');
		}

		if (!options.logGroupName) {
			throw new Error('no logGroupName provided');
		}

		this.logQueue = new Subject();
		this.options = _.defaults(options, {
			debounceTime: 5000
		});

		this.isStarted = false;
		this.client = options.client;
		this.logGroupName = options.logGroupName;
		this.random = _.now();

		this.start();
	}

	get streamName() {
		const date = new Date();
		const streamName = `${date.getDate()}/${date.getMonth()}/${date.getFullYear()}-${date.getHours()}-00-${this.random}`;

		if (streamName !== this._streamName) {
			this.sequenceToken = null;
			this._streamName = streamName;
		}

		return this._streamName;
	}

	start() {
		if (this.isStarted) {
			return;
		}

		this.isStarted = true;
		this.sourceDebounce = this.logQueue
			.debounceTime(this.options.debounceTime);

		this.logQueue
			.map(data => ({
				message: this.format(data),
				timestamp: _.now()
			}))
			.bufferWhen(() => this.sourceDebounce)
			.mergeMap(messages => {
				const streamName = this.streamName;

				if (this.sequenceToken) {
					return this.writeLogs(streamName, messages);
				} else {
					return this.createLogStream(streamName)
						.mergeMap(() => this.writeLogs(streamName, messages));
				}
			})
			.retry()
			.publish()
			.connect();
	}

	format(data) {
		if (_.isString(data)) {
			return data;
		} else if (data instanceof Error) {
			return JSON.stringify(beautyError(data), null, 2);
		}

		return JSON.stringify(data, null, 2);
	}

	log(message) {
		this.logQueue.next(message);
	}

	writeLogs(logStreamName, logEvents) {
		return Observable.create(subscriber => {
			const {
				logGroupName
			} = this;

			const logParams = {
				logEvents,
				logGroupName,
				logStreamName
			};

			if (this.sequenceToken) {
				logParams.sequenceToken = this.sequenceToken;
			}

			this.client.putLogEvents(logParams, (err, response) => {
				if (err) {
					return subscriber.error(err);
				}

				subscriber.next(response);
				subscriber.complete();
			});
		})
			.catch(err => {
				this.sequenceToken = null;

				return Observable.throw(err);
			})
			.do(response => {
				this.sequenceToken = response.nextSequenceToken;
			});
	}

	createLogStream(logStreamName) {
		return Observable.create(subscriber => {
			const {
					logGroupName
				} = this;

			this.client.createLogStream({
				logGroupName,
				logStreamName
			}, (err, response) => {
				if (err) {
					return subscriber.error(err);
				}

				subscriber.next(response);
				subscriber.complete();
			});
		})
			.retryWhen(err => {
				return err
					.mergeMap(err => {
						if (err.code === 'ResourceNotFoundException') {
							return this.createLogGroup();
						}

						return Observable.throw(err);
					});
			});
	}

	createLogGroup() {
		return Observable.create(subscriber => {
			const {
				logGroupName
			} = this;

			this.client.createLogGroup({
				logGroupName
			}, (err, response) => {
				if (err) {
					return subscriber.error(err);
				}

				subscriber.next(response);
				subscriber.complete();
			});
		});
	}
}
