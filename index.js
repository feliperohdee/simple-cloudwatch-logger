const _ = require('lodash');
const beautyError = require('simple-beauty-error');
const rx = require('rxjs');
const rxop = require('rxjs/operators');

module.exports = class CloudWatch {
    constructor(options) {
        if (!options.client) {
            throw new Error('no cloudwatch client provided');
        }

        if (!options.logGroupName) {
            throw new Error('no logGroupName provided');
        }

        this.logQueue = new rx.Subject();
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
        this.sourceDebounce = this.logQueue.pipe(
			rxop.debounceTime(this.options.debounceTime)
		);

        this.logQueue.pipe(
            rxop.map(data => ({
                message: this.format(data),
                timestamp: _.now()
            })),
            rxop.bufferWhen(() => this.sourceDebounce),
            rxop.mergeMap(messages => {
                const streamName = this.streamName;

                if (this.sequenceToken) {
                    return this.writeLogs(streamName, messages);
                } else {
                    return this.createLogStream(streamName)
                        .pipe(
							rxop.mergeMap(() => this.writeLogs(streamName, messages))
						);
                }
            }),
            rxop.retry(),
            rxop.publish()
		)
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
        return new rx.Observable(subscriber => {
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
            .pipe(
                rxop.catchError(err => {
                    this.sequenceToken = null;

                    return rx.throwError(err);
                }),
                rxop.tap(response => {
                    this.sequenceToken = response.nextSequenceToken;
                })
            );
    }

    createLogStream(logStreamName) {
        return new rx.Observable(subscriber => {
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
            .pipe(
                rxop.retryWhen(err => {
                    return err.pipe(
                        rxop.mergeMap(err => {
                            if (err.code === 'ResourceNotFoundException') {
                                return this.createLogGroup();
                            }

                            return rx.throwError(err);
                        })
                    );
                })
            );
    }

    createLogGroup() {
        return new rx.Observable(subscriber => {
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
};