const MAX_HP = 9487000;
const MAX_ATK = 8700000;
const MAX_EXP = 9487000;
const HP_L1_TARGET = 100;
const ATK_L1_TARGET = 10;
const EXPCAP_L1_TARGET = 100;
const K = 0.0046;
const CENTER = 2500;

function s(level) {
  return 1 / (1 + Math.exp(-K * (level - CENTER)));
}

const S1 = s(1);
const S5000 = s(5000);

function scaled(level) {
  return (s(level) - S1) / (S5000 - S1);
}

function hpAtLevel(level) {
  const val = HP_L1_TARGET + scaled(level) * (MAX_HP - HP_L1_TARGET);
  return Math.round(val);
}

function attackAtLevel(level) {
  const val = ATK_L1_TARGET + scaled(level) * (MAX_ATK - ATK_L1_TARGET);
  return Math.round(val);
}

function expAtLevel(level) {
  const val = EXPCAP_L1_TARGET + scaled(level) * (MAX_EXP - EXPCAP_L1_TARGET);
  return Math.round(val);
}

function actionAtLevel(level) {
  if (level <= 1) return 100;
  if (level >= 300) return 300;
  const frac = (level - 1) / (300 - 1);
  const val = 100 + frac * (300 - 100);
  return Math.round(val);
}

const levels = [1, 10, 50, 100, 300, 5000];
console.log('Level | HP | Attack | Exp Cap | Action');
levels.forEach(L => {
  const row = [L, hpAtLevel(L), attackAtLevel(L), expAtLevel(L), actionAtLevel(L)];
  console.log(row.join(' \t '));
});
