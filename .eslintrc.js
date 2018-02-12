"use strict";

module.exports = {
  env: {
    node: true
  },
  parserOptions: {
    ecmaVersion: 6
  },
  extends: ["eslint:recommended", "prettier"],
  overrides: [
    {
      files: "test/**/*.js",
      env: {
        mocha: true
      }
    }
  ]
};
