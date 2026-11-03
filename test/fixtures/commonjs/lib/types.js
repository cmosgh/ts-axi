'use strict';

function isRoute(value) {
  return value !== null && typeof value === 'object' && 'view' in value;
}

exports.isRoute = isRoute;
