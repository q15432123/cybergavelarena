const claude = require('./claude');
const kimi = require('./kimi');
const minimax = require('./minimax');

const models = { claude, kimi, minimax };

function getLLM(name) {
  const llm = models[name];
  if (!llm) throw new Error(`Unknown LLM: ${name}`);
  return llm;
}

function randomLLM() {
  const names = Object.keys(models);
  return names[Math.floor(Math.random() * names.length)];
}

module.exports = { getLLM, randomLLM, models };
