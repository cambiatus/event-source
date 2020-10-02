function parseToken (tokenString) {
  const [amountString] = tokenString.split(' ')
  const amount = parseFloat(amountString)
  const symbol = getSymbolFromAsset(tokenString)
  return [amount, symbol]
}

function getSymbolFromAsset (assetString) {
  const [amountString, symbolName] = assetString.split(' ')
  const [, decimalCases] = amountString.split('.')

  if (decimalCases === undefined) {
    return `0,${symbolName}`
  } else {
    return `${Number(decimalCases.length).toString()},${symbolName}`
  }
}

function getPrecisionFromSymbol (symbolString) {
  return symbolString.split(',')[0]
}

module.exports = {
  parseToken,
  getSymbolFromAsset,
  getPrecisionFromSymbol
}
