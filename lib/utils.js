'use strict';
// Gathered from http://stackoverflow.com/questions/5827612/node-js-fs-readdir-recursive-directory-search
exports.walk = function (dir, fs) {
  var path = require('path');
  var url = require('url');
  var results = [];
  var list = fs.readdirSync(dir);

  list.forEach(function (file) {
    file = path.join(dir, file);
    var stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results.push(url.resolve(file, ''));
      results = results.concat(exports.walk(file, fs));
    }
  });

  return results;
};
