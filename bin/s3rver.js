#!/usr/bin/env node
"use strict";

const fs = require("fs-extra");
const program = require("commander");
const pkg = require("../package.json");
const S3rver = require("..");

program.version(pkg.version, "--version");
program
  .option(
    "-h, --hostname [value]",
    "Set the host name or IP to bind to",
    "localhost"
  )
  .option("-p, --port <n>", "Set the port of the http server", 4568)
  .option("-s, --silent", "Suppress log messages", false)
  .option("-i, --indexDocument [path]", "Index Document for Static Web Hosting")
  .option(
    "-e, --errorDocument [path]",
    "Custom Error Document for Static Web Hosting"
  )
  .option("-d, --directory [path]", "Data directory")
  .option("-c, --cors [path]", "Path to S3 CORS configuration XML file")
  .option("--key [path]", "Path to private key file for running with TLS")
  .option("--cert [path]", "Path to certificate file for running with TLS")
  .parse(process.argv);

if (program.directory === undefined) {
  // eslint-disable-next-line no-console
  console.error("Data directory is required");
  process.exit();
}

try {
  const stats = fs.lstatSync(program.directory);
  if (stats.isDirectory() === false) {
    throw Error();
  }
} catch (e) {
  // eslint-disable-next-line no-console
  console.error(
    "Directory does not exist. Please create it and then run the command again"
  );
  process.exit();
}

if (program.cors) {
  program.cors = fs.readFileSync(program.cors);
}

if (program.key && program.cert) {
  program.key = fs.readFileSync(program.key);
  program.cert = fs.readFileSync(program.cert);
}

new S3rver(program).run(function(err, host, port) {
  if (err) {
    // eslint-disable-next-line no-console
    console.error(err);
  } else {
    // eslint-disable-next-line no-console
    console.log("now listening on host %s and port %d", host, port);
  }
});
