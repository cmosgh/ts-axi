'use strict';

var proto = require('./proto');

exports = module.exports = createApp;

function createApp() {
  var app = function (req) {
    return app.handle(req);
  };
  for (var key in proto) app[key] = proto[key];
  return app;
}
