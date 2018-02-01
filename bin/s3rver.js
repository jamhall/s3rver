#!/usr/bin/env node
'use strict';
const pkg     = require('../package.json');
const version = pkg.version;
const program = require('commander');
const fs      = require('fs-extra');
const S3rver  = require('../lib');

program.version(version, '--version');
program.option('-h, --hostname [value]', 'Set the host name or ip for the server', 'localhost')
  .option('-p, --port <n>', 'Set the port of the http server', 4568)
  .option('-s, --silent', 'Suppress log messages', false)
  .option('-i, --indexDocument [path]', 'Index Document for Static Web Hosting', '')
  .option('-e, --errorDocument [path]', 'Custom Error Document for Static Web Hosting', '')
  .option('-d, --directory [path]', 'Data directory')
  .option('-c, --cors', 'Enable CORS', false)
  .option('--key [path]', 'Path to private key file for running with TLS')
  .option('--cert [path]', 'Path to certificate file for running with TLS')
  .parse(process.argv);

if (program.directory === undefined) {
  console.error('Data directory is required');
  process.exit();
}

try {
  const stats = fs.lstatSync(program.directory);
  if (stats.isDirectory() === false) {
    throw Error();
  }
}
catch (e) {
  console.error('Directory does not exist. Please create it and then run the command again');
  process.exit();
}

if (program.key && program.cert) {
  program.key = fs.readFileSync(program.key);
  program.cert = fs.readFileSync(program.cert);
}

const s3rver = new S3rver(program).run(function (err, host, port) {
  if (err) {
    console.error(err)
  } else {
    console.log('now listening on host %s and port %d', host, port);
  }
});

s3rver.s3Event.subscribe({
  next: function (event) {
    console.log(event);
  }
});

s3rver.s3Event.filter(function (event) { return event.Records[0].eventName == 'ObjectCreated:Copy' }).subscribe({
  next: function (event) {
    console.log(event);
  }
});
