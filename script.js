const pipeData = {
  // 管徑: { 厚度: { outerDiameter, listPrice } }
  '20': {
    '10': { outerDiameter: 40, listPrice: 100 },
    '20': { outerDiameter: 60, listPrice: 120 }
  },
  '25': {
    '10': { outerDiameter: 50, listPrice: 150 },
    '20': { outerDiameter: 70, listPrice: 170 }
  }
};

const diameterSelect = document.getElementById('diameterSelect');
const thicknessSelect = document.getElementById('thicknessSelect');
const specInfo = document.getElementById('specInfo');
const discountInput = document.getElementById('discountInput');
const taxSelect = document.getElementById('taxSelect');
const result = document.getElementById('result');

function init() {
  Object.keys(pipeData).forEach(diameter => {
    const opt = document.createElement('option');
    opt.value = diameter;
    opt.textContent = diameter;
    diameterSelect.appendChild(opt);
  });
}

function updateThickness() {
  const diameter = diameterSelect.value;
  thicknessSelect.innerHTML = '<option value="">選擇厚度</option>';
  thicknessSelect.disabled = !diameter;
  if (!diameter) {
    specInfo.textContent = '';
    updateResult();
    return;
  }
  Object.keys(pipeData[diameter]).forEach(thickness => {
    const opt = document.createElement('option');
    opt.value = thickness;
    opt.textContent = thickness;
    thicknessSelect.appendChild(opt);
  });
  specInfo.textContent = '';
  updateResult();
}

function updateSpec() {
  const diameter = diameterSelect.value;
  const thickness = thicknessSelect.value;
  if (diameter && thickness) {
    const spec = pipeData[diameter][thickness];
    specInfo.textContent = `外徑: ${spec.outerDiameter} mm\n牌價: ${spec.listPrice.toFixed(2)} 元/公尺`;
  } else {
    specInfo.textContent = '';
  }
  updateResult();
}

function updateResult() {
  const diameter = diameterSelect.value;
  const thickness = thicknessSelect.value;
  const discount = parseFloat(discountInput.value);
  const taxRate = parseFloat(taxSelect.value);
  result.textContent = '';

  if (!(diameter && thickness && !isNaN(discount))) return;

  const spec = pipeData[diameter][thickness];
  const listPricePerMeter = spec.listPrice;
  const discountedPerMeter = +(listPricePerMeter * discount / 100).toFixed(2);
  const perPiece = +(discountedPerMeter * 2.4).toFixed(2);
  const net = perPiece;
  const tax = +(net * taxRate / 100).toFixed(2);
  const total = +(net + tax).toFixed(2);

  result.textContent =
    `牌價每公尺: ${listPricePerMeter.toFixed(2)} 元\n` +
    `每公尺單價: ${discountedPerMeter.toFixed(2)} 元\n` +
    `每支: ${perPiece.toFixed(2)} 元\n` +
    `銷貨淨額: ${net.toFixed(2)} 元\n` +
    `稅額: ${tax.toFixed(2)} 元\n` +
    `銷貨總額: ${total.toFixed(2)} 元`;
}

diameterSelect.addEventListener('change', updateThickness);
thicknessSelect.addEventListener('change', updateSpec);
discountInput.addEventListener('input', updateResult);
taxSelect.addEventListener('change', updateResult);

init();
