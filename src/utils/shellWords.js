/** Basit kabuk kelime bölme: tek/çift tırnak ve ters bölü kaçışı desteklenir. */
function splitShellWords(input) {
  const words = [];
  let current = '';
  let quote = null;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) words.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) words.push(current);
  return words;
}

module.exports = { splitShellWords };
