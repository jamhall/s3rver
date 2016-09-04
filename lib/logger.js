'use strict';
module.exports = function (silent) {
  var winston = require('winston');
  winston.emitErrs = true;
  var logger = new winston.Logger({
    transports: [
      new winston.transports.Console({
        level: 'debug',
        handleExceptions: true,
        json: false,
        colorize: true,
        label: 'S3rver'
      })
    ],
    exitOnError: false
  });

  if (silent) {
    logger.remove(winston.transports.Console);
  }
  return logger;
};
