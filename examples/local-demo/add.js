function add(...values) {
  return values.reduce((sum, v) => sum + v, 0);
}

module.exports = add;
