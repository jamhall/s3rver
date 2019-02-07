"use strict";

const { createLogger, format, transports } = require("winston");

module.exports = function(silent) {
  const logger = createLogger({
    transports: [
      new transports.Console({
        level: "debug",
        json: false,
        format: format.combine(
          format.colorize(),
          format.splat(),
          format.simple()
        ),
        silent
      })
    ],
    exitOnError: false
  });
  logger.emitErrs = true;

  return logger;
};
