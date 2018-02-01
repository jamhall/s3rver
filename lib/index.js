'use strict';

const fs = require('fs-extra');
const path = require('path');
const async = require('async');
const _ = require('lodash');
const App = require('./app');
const utils = require('./utils');

const S3rver = function (options) {
  this.options = {
    port: 4578,
    hostname: 'localhost',
    silent: false,
    indexDocument: '',
    errorDocument: '',
    removeBucketsOnClose: false
  };

  if (options) {
    this.options = _.merge(this.options, options);

    // Lodash 3 does not merge Buffers correctly.
    // https://github.com/lodash/lodash/issues/1453
    if (options.key && options.cert) {
      this.options.key = options.key;
      this.options.cert = options.cert;
    }
  }

};

S3rver.prototype.resetFs = function (callback) {
  const { directory } = this.options;
  fs.readdir(directory, function (err, buckets) {
    if (err) return callback(err);
    async.eachSeries(buckets, function (bucket, callback) {
      fs.remove(path.join(directory, bucket), callback);
    }, callback);
  });
}

S3rver.prototype.run = function (done) {
  const app = new App(this.options);
  const server = app.serve(done);
  server.s3Event = app.s3Event;
  if (this.options.removeBucketsOnClose) {
    const close = server.close.bind(server);
    server.close = (...args) => {
      this.resetFs(() => {
        close(...args);
      });
    };
  }
  return server;
};

module.exports = S3rver;

