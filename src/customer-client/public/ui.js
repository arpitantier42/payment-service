import {
  buildOrderRequest,
  buildPaymentRequest,
  cartTotal,
  checkoutAction,
  createIdempotencyKeys,
  describeError,
  describePayment,
  formatAmount,
  submitPayment,
} from './checkout.js';

// Demo catalog (prices in minor units). The order total is what order-service stores and what
// payment-service later validates the payment amount against.
const CURRENCY = 'INR';
const CATALOG = [
  { sku: 'tea', name: 'Assam tea, 250 g', price: 34900 },
  { sku: 'mug', name: 'Ceramic mug', price: 19900 },
  { sku: 'kettle', name: 'Stovetop kettle', price: 129900 },
];
const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT = 45;

const $ = (id) => document.getElementById(id);
const keys = createIdempotencyKeys(sessionStorage, () => crypto.randomUUID());

// Placeholder customer identity until a real login exists: one random id per browser.
function customerId() {
  let id = localStorage.getItem('customer_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('customer_id', id);
  }
  return id;
}

async function api(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function say(message, tone = 'info') {
  $('message').textContent = message;
  $('message').className = tone;
}

function show(step) {
  for (const id of ['cart-step', 'pay-step', 'result-step']) $(id).hidden = id !== step;
}

const saveOrder = (order) => sessionStorage.setItem('current_order', JSON.stringify(order));
const loadOrder = () => JSON.parse(sessionStorage.getItem('current_order') ?? 'null');

// ---- step 1: cart -> POST /orders (REQ-001)
function renderCart() {
  const tbody = $('cart').querySelector('tbody');
  tbody.replaceChildren(
    ...CATALOG.map((item) => {
      const tr = document.createElement('tr');
      const qty = Object.assign(document.createElement('input'), { type: 'number', min: '0', max: '20', value: '0' });
      qty.dataset.sku = item.sku;
      qty.addEventListener('input', updateTotal);
      const cells = [item.name, formatAmount(item.price, CURRENCY)].map((t) => Object.assign(document.createElement('td'), { textContent: t }));
      const qtyCell = document.createElement('td');
      qtyCell.append(qty);
      tr.append(...cells, qtyCell);
      return tr;
    }),
  );
  updateTotal();
}

function cartLines() {
  return CATALOG.map((item) => {
    const input = $('cart').querySelector(`input[data-sku="${item.sku}"]`);
    const quantity = Math.max(0, Math.min(20, Number.parseInt(input?.value ?? '0', 10) || 0));
    return { ...item, quantity };
  });
}

function updateTotal() {
  $('cart-total').textContent = formatAmount(cartTotal(cartLines()), CURRENCY);
}

async function placeOrder() {
  const { value, errors } = buildOrderRequest({ customerId: customerId(), totalAmount: cartTotal(cartLines()), currency: CURRENCY });
  if (errors) return say(errors.map((e) => e.message).join('; '), 'error');
  $('place-order').disabled = true;
  try {
    const { status, body } = await api('POST', '/orders', { body: value }).catch(() => ({ status: 0, body: null }));
    if (status !== 201) return say(describeError(status, body).message, 'error');
    saveOrder(body);
    showPayStep(body);
    say('Order placed. Choose how you want to pay.');
  } finally {
    $('place-order').disabled = false;
  }
}

// ---- step 2: POST /payments with an Idempotency-Key, then redirect (REQ-002, REQ-005)
function showPayStep(order) {
  $('order-id').textContent = order.id;
  $('order-status').textContent = order.status;
  $('order-amount').textContent = formatAmount(order.total_amount, order.currency);
  show('pay-step');
}

async function pay() {
  const order = loadOrder();
  const method = document.querySelector('input[name="payment_method"]:checked')?.value;
  const { value, errors } = buildPaymentRequest({ order, paymentMethod: method });
  if (errors) return say(`Missing: ${errors.map((e) => e.field).join(', ')}`, 'error');

  $('pay').disabled = true;
  try {
    const post = (request, key) => api('POST', '/payments', { body: request, headers: { 'Idempotency-Key': key } });
    const { status, body } = await submitPayment({ request: value, keys, post });
    if (status !== 200 && status !== 201) {
      const { message } = describeError(status, body);
      return say(message, 'error');
    }
    const next = checkoutAction(body);
    switch (next.action) {
      case 'redirect':
        say('Redirecting to the secure checkout…');
        window.location.assign(next.url);
        return;
      case 'expired':
        // REQ-006: never send the customer to a lapsed session; the next attempt uses a new key.
        keys.forget(order.id);
        return say('Your checkout session expired. Press "Continue to payment" to start a new one.', 'error');
      case 'final':
        keys.forget(order.id);
        return showResult(body);
      case 'retry':
        return say('The payment provider is not responding. Try again in a moment.', 'error');
      default:
        return say('The payment provider returned an unusable checkout link.', 'error');
    }
  } finally {
    $('pay').disabled = false;
  }
}

// ---- step 3: back from the hosted checkout: poll the payment (REQ-006)
async function showResult(payment) {
  show('result-step');
  $('payment-id').textContent = payment.id;
  $('payment-status').textContent = payment.status;
  const view = describePayment(payment);
  say(view.message, view.tone);
  const order = await api('GET', `/orders/${encodeURIComponent(payment.order_id)}`).catch(() => null);
  if (order?.status === 200) {
    $('result-order-status').textContent = order.body.status;
    saveOrder(order.body);
  }
  $('try-again').hidden = !(view.final && payment.status !== 'SUCCESS' && order?.body?.status === 'PAYMENT_FAILED');
  return view;
}

async function pollPayment(paymentId) {
  for (let i = 0; i < POLL_LIMIT; i++) {
    const { status, body } = await api('GET', `/payments/${encodeURIComponent(paymentId)}`).catch(() => ({ status: 0 }));
    if (status === 200) {
      const view = await showResult(body);
      if (view.final) {
        if (body.status !== 'SUCCESS') keys.forget(body.order_id);
        return;
      }
    } else if (status === 404) {
      return say('We could not find this payment.', 'error');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  say('Your payment is still being confirmed. Refresh this page later to see the result.');
}

function startOver() {
  sessionStorage.removeItem('current_order');
  history.replaceState(null, '', '/');
  say('');
  renderCart();
  show('cart-step');
}

$('place-order').addEventListener('click', placeOrder);
$('pay').addEventListener('click', pay);
$('new-order').addEventListener('click', startOver);
$('try-again').addEventListener('click', () => {
  history.replaceState(null, '', '/');
  say('');
  showPayStep(loadOrder());
});

const params = new URLSearchParams(window.location.search);
const returningPayment = params.get('payment_id');
renderCart();
if (returningPayment) {
  show('result-step');
  pollPayment(returningPayment);
} else if (loadOrder()?.status === 'PENDING_PAYMENT') {
  showPayStep(loadOrder());
}
