'use strict';
const Bucket = function (name, creationDate) {
  return {
    name: name,
    creationDate: creationDate
  };
};
module.exports = Bucket;