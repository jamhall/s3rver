"use strict";

const winston = require("winston");

module.exports = function(silent) {
  const logger = winston.createLogger({
    transports: [
      new winston.transports.Console({
        level: "debug",
        json: false
      })
    ],
    exitOnError: false
  });
  logger.emitErrs = true;

  if (silent) {
    logger.remove(winston.transports.Console);
  }
  return logger;
};
