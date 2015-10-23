#!/usr/bin/env node
'use strict';
var pkg     = require('../package.json'),
    version = pkg.version,
    program = require('commander'),
    fs      = require('fs'),
    S3rver  = require('../lib');

program.version(version, '--version');
program.option('-h, --hostname [value]', 'Set the host name or ip for the server', 'localhost')
  .option('-p, --port <n>', 'Set the port of the http server', 4568)
  .option('-s, --silent', 'Suppress log messages', false)
  .option('-i, --indexDocument [value]', 'Index Document for Static Web Hosting', '')
  .option('-e, --errorDocument', 'Custom Error Document for Static Web Hosting', '')
  .option('-d, --directory [path]', 'Data directory')
  .parse(process.argv);

if (program.directory === undefined) {
  console.error('Data directory is required');
  return;
}

try {
  var stats = fs.lstatSync(program.directory);
  if (stats.isDirectory() === false) {
    throw Error();
  }
}
catch (e) {
  console.error('Directory does not exist. Please create it and then run the command again');
  return;
}

var s3rver = new S3rver(program).run(function (err, host, port) {
  console.log('now listening on host %s and port %d', host, port);
});
