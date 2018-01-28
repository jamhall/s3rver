"use strict";

const winston = require("winston");

module.exports = function(silent) {
  winston.emitErrs = true;
  const logger = new winston.Logger({
    transports: [
      new winston.transports.Console({
        level: "debug",
        humanReadableUnhandledException: true,
        handleExceptions: true,
        json: false,
        colorize: true,
        label: "S3rver"
      })
    ],
    exitOnError: false
  });

  if (silent) {
    logger.remove(winston.transports.Console);
  }
  return logger;
};
