(function (root) {
  const pad = (value) => String(value).padStart(2, " ");

  root.label = function (value) {
    return pad(value) + pad(value);
  };
})(this);
