'use strict';
var App = require('./app');
var _ = require('lodash');
var https = require('https');

var defaultOptions = {
  port: 4578,
  hostname: 'localhost',
  directory: '.',
  silent: false,
  indexDocument: '',
  errorDocument: '',
  fs: require('fs-extra')
};

function S3rver(options) {
  this.options = _.merge({}, defaultOptions, options);
  this.app = new App(this.options);
}

for (var option in defaultOptions) {
  S3rver.prototype['set' + option.charAt(0).toUpperCase() + option.slice(1)] = function (value) {
    this.options[option] = value;
    this.app = new App(this.options);
    return this;
  }
}

S3rver.prototype.run = function (done) {
  var options = this.options;
  var server = ((options.key && options.cert) || options.pfx)
      ? https.createServer(options, this.app)
      : this.app;
  return server.listen(options.port, options.hostname, function (err) {
    return done(err, options.hostname, options.port, options.directory);
  }).on('error', done);
};

module.exports = S3rver;
