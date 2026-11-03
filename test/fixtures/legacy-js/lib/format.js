(function (root) {
  function pad(value, width) {
    var text = String(value);
    while (text.length < width) text = "0" + text;
    return text;
  }

  var stamp = function (date) {
    return pad(date.getHours(), 2) + ":" + pad(date.getMinutes(), 2);
  };

  root.stamp = stamp;
})(this);
