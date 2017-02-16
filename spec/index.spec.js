const _ = require('lodash');
const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');

const AWS = require('aws-sdk');
const {
	Observable,
	Subject,
	TestScheduler
} = require('rxjs');

const Logger = require('../');

AWS.config.update({
	accessKeyId: process.env.accessKeyId,
	secretAccessKey: process.env.secretAccessKey,
	region: 'us-east-1'
});

const expect = chai.expect;
const cloudWatchLogsClient = new AWS.CloudWatchLogs();

chai.use(sinonChai);

describe.only('index.spec.js', () => {
	let logger;

	beforeEach(() => {
		sinon.spy(Logger.prototype, 'start');

		logger = new Logger({
			client: cloudWatchLogsClient,
			logGroupName: 'specGroup'
		});
	});

	afterEach(() => {
		Logger.prototype.start.restore();
	});

	describe('constructor', () => {
		it('should throw if no client', () => {
			expect(() => new Logger({
				logGroupName: 'specGroup'
			})).to.throw('no cloudwatch client provided');
		});

		it('should throw if no logGroupName', () => {
			expect(() => new Logger({
				client: cloudWatchLogsClient
			})).to.throw('no logGroupName provided');
		});

		it('should have options', () => {
			expect(logger.options).to.deep.equal({
				debounceTime: 5000,
				logGroupName: 'specGroup',
				client: cloudWatchLogsClient
			});
		});

		it('should have logQueue', () => {
			expect(logger.logQueue).to.be.instanceOf(Subject);
		});

		it('should have a random', () => {
			expect(logger.random).to.be.a('number');
		});

		it('should start', () => {
			expect(Logger.prototype.start).to.have.been.calledOnce;
		});
	});

	describe('streamName', () => {
		it('should compose', () => {
			expect(logger.streamName).to.be.a.string;
		});

		it('should fill _streamName and null sequenceToken if different', () => {
			logger._streamName = 'oldStreamName';
			logger.sequenceToken = 'sequenceToken';

			const streamName = logger.streamName;

			expect(logger._streamName).to.equal(streamName);
			expect(logger.sequenceToken).to.be.null;
		});

		it('should return _streamName and sequenceToken if same', () => {
			const streamName = logger.streamName;
			logger._streamName = logger.streamName;
			logger.sequenceToken = 'sequenceToken';

			expect(logger.streamName).to.equal(logger._streamName);
			expect(logger.sequenceToken).to.equal('sequenceToken');
		});
	});

	describe('start', () => {
		let testScheduler;

		beforeEach(() => {
			testScheduler = new TestScheduler();

			const originalDebounceTime = Observable.prototype.debounceTime;

			sinon.stub(Observable.prototype, 'debounceTime')
				.callsFake(function(...args) {
					return originalDebounceTime.apply(this, args.concat(testScheduler));
				});


			logger = new Logger({
				client: cloudWatchLogsClient,
				logGroupName: 'specGroup',
				debounceTime: 100
			});
		});

		afterEach(() => {
			Observable.prototype.debounceTime.restore();
		});

		it('should set isStarted', () => {
			expect(logger.isStarted).to.be.true;
		});

		it('should set sourceDebounce', () => {
			expect(logger.sourceDebounce).to.exists;
		});

		it('should subscribe logQueue', () => {
			expect(logger.logQueue.isStopped).to.be.false;
		});

		describe('logQueue', () => {
			beforeEach(() => {
				sinon.stub(logger, 'writeLogs')
					.returns(Observable.of(null));
				sinon.stub(logger, 'createLogStream')
					.returns(Observable.of(null));
			});

			afterEach(() => {
				logger.writeLogs.restore();
				logger.createLogStream.restore();
			});

			it('should call createLogStream and writeLogs', () => {
				logger.logQueue.next('test');
				logger.logQueue.next(new Error('error'));
				logger.logQueue.next({
					test: 'test'
				});

				testScheduler.flush();

				expect(logger.createLogStream).to.have.been.calledOnce;
				expect(logger.writeLogs).to.have.been.calledOnce;
			});

			it('should call writeLogs with batched messages', () => {
				logger._streamName = logger.streamName;
				logger.sequenceToken = 'sequenceToken';

				logger.logQueue.next('test');
				logger.logQueue.next(new Error('error'));
				logger.logQueue.next({
					test: 'test'
				});

				testScheduler.flush();

				expect(logger.createLogStream).not.to.have.been.called;
				expect(logger.writeLogs).to.have.been.calledOnce;
				expect(logger.writeLogs).to.have.been.calledWith(sinon.match.string, [{
					message: 'test',
					timestamp: sinon.match.number
				}, {
					message: sinon.match.string,
					timestamp: sinon.match.number
				}, {
					message: JSON.stringify({
						test: 'test'
					}, null, 2),
					timestamp: sinon.match.number
				}]);
			});
		});

		describe('logQueue observable error', () => {
			beforeEach(() => {
				sinon.stub(logger, 'writeLogs')
					.returns(Observable.of(null));

				sinon.stub(logger, 'createLogStream')
					.onFirstCall()
					.returns(Observable.throw(new Error('error')))
					.onSecondCall()
					.returns(Observable.of(null));
			});

			afterEach(() => {
				logger.writeLogs.restore();
				logger.createLogStream.restore();
			});

			it('should call createLogStream and writeLogs', () => {
				logger.logQueue.next('test');
				logger.logQueue.next(new Error('error'));
				logger.logQueue.next({
					test: 'test'
				});

				testScheduler.flush();

				logger.logQueue.next('test');
				logger.logQueue.next(new Error('error'));
				logger.logQueue.next({
					test: 'test'
				});

				testScheduler.flush();

				expect(logger.writeLogs).to.have.been.calledOnce;
			});
		});

		describe('logQueue internal error', () => {
			beforeEach(() => {
				sinon.stub(logger, 'writeLogs')
					.returns(Observable.of(null));

				sinon.stub(logger, 'createLogStream')
					.onFirstCall()
					.throws(new Error('internal error'))
					.onSecondCall()
					.returns(Observable.of(null));
			});

			afterEach(() => {
				logger.writeLogs.restore();
				logger.createLogStream.restore();
			});

			it('should call writeLogs', () => {
				logger.logQueue.next('test');
				logger.logQueue.next(new Error('error'));
				logger.logQueue.next({
					test: 'test'
				});

				testScheduler.flush();

				logger.logQueue.next('test');
				logger.logQueue.next(new Error('error'));
				logger.logQueue.next({
					test: 'test'
				});

				testScheduler.flush();

				expect(logger.writeLogs).to.have.been.calledOnce;
			});
		});
	});

	describe('format', () => {
		it('should handle string', () => {
			expect(logger.format('test')).to.equal('test');
		});

		it('should handle object', () => {
			expect(logger.format({
				test: 'test'
			})).to.equal(JSON.stringify({
				test: 'test'
			}, null, 2));
		});

		it('should handle error', () => {
			const err = new Error('test');

			expect(logger.format(err)).to.equal(logger.stringifyStack(err.stack));
		});

		it('should handle empty error', () => {
			const err = new Error();

			expect(logger.format(err)).to.equal(logger.stringifyStack(err.stack));
		});
	});

	describe('stringifyStack', () => {
		it('should compose', () => {
			expect(logger.stringifyStack({
				stack: `
					stack
				`
			})).to.equal('{"stack":"\n\t\t\t\t\tstack\n\t\t\t\t"}');
		});
	});

	describe('log', () => {
		beforeEach(() => {
			sinon.stub(logger.logQueue, 'next');
		});

		afterEach(() => {
			logger.logQueue.next.restore();
		});

		it('should call logQueue.next', () => {
			logger.log('test');

			expect(logger.logQueue.next).to.have.been.calledWith('test');
		});
	});

	describe('writeLogs', () => {
		beforeEach(() => {
			sinon.stub(logger.client, 'putLogEvents');
		});

		afterEach(() => {
			logger.client.putLogEvents.restore();
		});

		it('should call client.putLogEvents', () => {
			logger.writeLogs('logStreamName', [{
					message: 'test',
					timestamp: 123
				}])
				.subscribe();

			expect(logger.client.putLogEvents).to.have.been.calledOnce;
			expect(logger.client.putLogEvents).to.have.been.calledWith({
				logStreamName: 'logStreamName',
				logGroupName: 'specGroup',
				logEvents: [{
					message: 'test',
					timestamp: 123
				}]
			});
		});

		it('should call client.putLogEvents with sequenceToken', () => {
			logger.sequenceToken = 'sequenceToken';
			logger.writeLogs('logStreamName', [{
					message: 'test',
					timestamp: 123
				}])
				.subscribe();

			expect(logger.client.putLogEvents).to.have.been.calledOnce;
			expect(logger.client.putLogEvents).to.have.been.calledWith({
				logStreamName: 'logStreamName',
				logGroupName: 'specGroup',
				logEvents: [{
					message: 'test',
					timestamp: 123
				}],
				sequenceToken: 'sequenceToken'
			});
		});

		describe('returning nextSequenceToken', () => {
			beforeEach(() => {
				if (logger.client.putLogEvents.restore) {
					logger.client.putLogEvents.restore();
				}

				sinon.stub(logger.client, 'putLogEvents')
					.callsFake(({}, callback) => {
						callback(null, {
							nextSequenceToken: 'newSequenceToken'
						});
					});
			});

			it('should fill new sequenceToken', done => {
				logger.writeLogs('logStreamName', [{
						message: 'test',
						timestamp: 123
					}])
					.subscribe(response => {
						expect(logger.sequenceToken).to.equal('newSequenceToken');
					}, null, done);
			});
		});

		describe('returning error', () => {
			beforeEach(() => {
				if (logger.client.putLogEvents.restore) {
					logger.client.putLogEvents.restore();
				}

				sinon.stub(logger.client, 'putLogEvents')
					.callsFake(({}, callback) => {
						callback(new Error('error'));
					});
			});

			it('should null sequenceToken and throw err', done => {
				logger.writeLogs('logStreamName', [{
						message: 'test',
						timestamp: 123
					}])
					.subscribe(null, err => {
						expect(logger.sequenceToken).to.be.null;
						expect(err.message).to.equal('error');

						done();
					});
			});
		});
	});

	describe('createLogStream', () => {
		beforeEach(() => {
			sinon.stub(logger.client, 'createLogStream');
		});

		afterEach(() => {
			logger.client.createLogStream.restore();
		});

		it('should call client.createLogStream', () => {
			logger.createLogStream('logStreamName')
				.subscribe();

			expect(logger.client.createLogStream).to.have.been.calledOnce;
			expect(logger.client.createLogStream).to.have.been.calledWith({
				logStreamName: 'logStreamName',
				logGroupName: 'specGroup'
			});
		});

		describe('returning ResourceNotFoundException error', () => {
			beforeEach(() => {
				if (logger.client.createLogStream.restore) {
					logger.client.createLogStream.restore();
				}

				const returnsError = ({}, callback) => {
					const err = new Error('ResourceNotFoundException');
					err.code = 'ResourceNotFoundException';

					callback(err);
				};

				const returnsSuccess = ({}, callback) => {
					callback(null, 'success');
				};

				sinon.stub(logger, 'createLogGroup')
					.returns(Observable.of(null));

				sinon.stub(logger.client, 'createLogStream')
					.onFirstCall()
					.callsFake(returnsError)
					.onSecondCall()
					.callsFake(returnsSuccess);
			});

			afterEach(() => {
				logger.createLogGroup.restore();
			});

			it('should call createLogGroup and retry', done => {
				logger.createLogStream('logStreamName')
					.subscribe(() => {
						expect(logger.client.createLogStream).to.have.been.calledTwice;
						expect(logger.createLogGroup).to.have.been.called;
					}, null, done);
			});
		});

		describe('returning arbitrary error', () => {
			beforeEach(() => {
				if (logger.client.createLogStream.restore) {
					logger.client.createLogStream.restore();
				}

				sinon.stub(logger, 'createLogGroup')
					.returns(Observable.of(null));

				sinon.stub(logger.client, 'createLogStream')
					.onFirstCall()
					.callsFake(({}, callback) => {
						const err = new Error('error');

						callback(err);
					});
			});

			afterEach(() => {
				logger.createLogGroup.restore();
			});

			it('should throw', done => {
				logger.createLogStream('logStreamName')
					.subscribe(null, err => {
						expect(err.message).to.equal('error');

						done();
					});
			});
		});
	});

	describe('createLogGroup', () => {
		beforeEach(() => {
			sinon.stub(logger.client, 'createLogGroup');
		});

		afterEach(() => {
			logger.client.createLogGroup.restore();
		});

		it('should call client.createLogGroup', () => {
			logger.createLogGroup('logStreamName')
				.subscribe();

			expect(logger.client.createLogGroup).to.have.been.calledOnce;
			expect(logger.client.createLogGroup).to.have.been.calledWith({
				logGroupName: 'specGroup'
			});
		});

		describe('returning success', () => {
			beforeEach(() => {
				if (logger.client.createLogGroup.restore) {
					logger.client.createLogGroup.restore();
				}

				sinon.stub(logger.client, 'createLogGroup')
					.callsFake(({}, callback) => callback(null, 'success'));
			});

			it('should return success', done => {
				logger.createLogGroup('logStreamName')
					.subscribe(response => {
						expect(response).to.equal('success');
					}, null, done);
			});
		});

		describe('returning arbitrary error', () => {
			beforeEach(() => {
				if (logger.client.createLogGroup.restore) {
					logger.client.createLogGroup.restore();
				}

				sinon.stub(logger.client, 'createLogGroup')
					.callsFake(({}, callback) => callback(new Error('error')));
			});

			it('should return success', done => {
				logger.createLogGroup('logStreamName')
					.subscribe(null, err => {
						expect(err.message).to.equal('error');

						done();
					});
			});
		});
	});
});
