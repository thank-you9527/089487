const MAX_HP = 9487000;
const MAX_ATK = 8700000;
const MAX_EXP = 9487000;
const K = 0.00092;
const CENTER = 2500;

function logistic(max, level) {
  return max / (1 + Math.exp(-K * (level - CENTER)));
}

function hpAtLevel(level) {
  return Math.round(logistic(MAX_HP, level));
}

function attackAtLevel(level) {
  return Math.round(10 + (MAX_ATK - 10) / (1 + Math.exp(-K * (level - CENTER))));
}

function expAtLevel(level) {
  return Math.round(logistic(MAX_EXP, level));
}

function actionAtLevel(level) {
  return Math.round(100 + (10000 - 100) * (level - 1) / 4999);
}

const levels = [1,10,50,100,300,500,1000];
console.log('Level | HP | Attack | Exp Cap | Action');
levels.forEach(L => {
  const row = [L, hpAtLevel(L), attackAtLevel(L), expAtLevel(L), actionAtLevel(L)];
  console.log(row.join(' \t '));
});
