'use strict';

var types = require('./types');

var app = exports = module.exports = {};

app.handle = function handle(req) {
  return types.isRoute(req) ? this.render(req.view) : null;
};

app.render = function render(view) {
  return '<' + view + '>';
};
