function mean(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const sum = values.reduce((total, v) => total + v, 0);
  return sum / values.length;
}

module.exports = mean;
