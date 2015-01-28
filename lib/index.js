'use strict';
var App = require('./app');
var S3rver = function () {
  this.port = 4578;
  this.hostname = 'localhost';
  this.silent = false;
};

S3rver.prototype.setPort = function (port) {
  this.port = port;
  return this;
};

S3rver.prototype.setHostname = function (hostname) {
  this.hostname = hostname;
  return this;
};

S3rver.prototype.setDirectory = function (directory) {
  this.directory = directory;
  return this;
};

S3rver.prototype.setSilent = function (silent) {
  this.silent = silent;
  return this;
};

S3rver.prototype.run = function (done) {
  var app = new App(this.hostname, this.port, this.directory, this.silent);
  return app.serve(done);

};

module.exports = S3rver;
