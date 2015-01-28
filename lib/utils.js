'use strict';
// Gathered from http://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search
exports.walk = function (dir) {
  var fs = require('fs');
  var path = require('path');
  var results = [];
  var list = fs.readdirSync(dir);

  list.forEach(function (file) {
    file = path.join(dir, file);
    var stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results.push(file);
      results = results.concat(exports.walk(file));
    }
  });

  return results;
};
