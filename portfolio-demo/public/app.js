const money = new Intl.NumberFormat('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 0 });
const shortDate = new Intl.DateTimeFormat('en-PK', { month: 'short', day: 'numeric', timeZone: 'Asia/Karachi' });
const chatTime = new Intl.DateTimeFormat('en-PK', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Karachi' });

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function renderMetrics(data) {
  const cards = [
    { icon: '↗', label: 'Sales today', value: money.format(data.salesToday), sub: 'Non-cancelled orders' },
    { icon: '◎', label: 'Unpaid customers', value: data.unpaidCustomers.count, sub: `${money.format(data.unpaidCustomers.total)} outstanding` },
    { icon: '★', label: 'Top product', value: data.topProduct?.name ?? 'No sales yet', sub: data.topProduct ? `${data.topProduct.total_qty_sold} units sold` : 'Waiting for orders' },
    { icon: '◷', label: 'Pending follow-ups', value: data.pendingFollowups, sub: 'Computed from order state' },
  ];
  document.querySelector('#metrics').innerHTML = cards.map((card) => `
    <article class="metric-card">
      <span class="metric-icon">${card.icon}</span>
      <span class="metric-label">${card.label}</span>
      <strong class="metric-value" title="${card.value}">${card.value}</strong>
      <span class="metric-sub">${card.sub}</span>
    </article>`).join('');
}

function renderOrders(orders) {
  document.querySelector('#orders').innerHTML = orders.map((order) => {
    const item = order.items[0];
    const created = new Date(`${order.created_at.replace(' ', 'T')}Z`);
    return `<tr>
      <td><span class="order-id">#${String(order.id).padStart(3, '0')}</span><span class="item-qty">${shortDate.format(created)}</span></td>
      <td>${order.customer}</td>
      <td><span class="item-name">${item.name}</span><span class="item-qty">Qty ${item.quantity}</span></td>
      <td><span class="amount">${money.format(order.total)}</span></td>
      <td><span class="status status-${order.status}">${order.status}</span></td>
    </tr>`;
  }).join('');
}

async function showConversation(customer) {
  document.querySelectorAll('.conversation-tab').forEach((tab) => tab.classList.toggle('active', Number(tab.dataset.id) === customer.id));
  const header = document.querySelector('#chat-header');
  const initials = customer.name.split(' ').map((part) => part[0]).join('').slice(0, 2);
  header.innerHTML = `<div class="chat-avatar">${initials}</div><div><b>${customer.name}</b><small>synthetic customer · demo scenario</small></div>`;
  const data = await getJson(`/api/conversations/${customer.id}/messages`);
  const body = document.querySelector('#chat-body');
  body.innerHTML = data.messages.map((message) => {
    const created = new Date(`${message.created_at.replace(' ', 'T')}Z`);
    return `<div class="bubble-row ${message.direction}"><div class="bubble">${message.body}<time>${shortDate.format(created)} · ${chatTime.format(created)}${message.direction === 'outbound' ? ' ✓✓' : ''}</time></div></div>`;
  }).join('');
  body.scrollTop = body.scrollHeight;
}

async function renderConversations(customers) {
  const list = document.querySelector('#conversation-list');
  list.innerHTML = customers.map((customer) => {
    const initials = customer.name.split(' ').map((part) => part[0]).join('').slice(0, 2);
    return `<button class="conversation-tab" type="button" data-id="${customer.id}"><span class="tab-avatar">${initials}</span><span><b>${customer.name}</b><small>${customer.summary}</small></span><i></i></button>`;
  }).join('');
  list.querySelectorAll('.conversation-tab').forEach((button) => {
    button.addEventListener('click', () => showConversation(customers.find((customer) => customer.id === Number(button.dataset.id))));
  });
  if (customers[0]) await showConversation(customers[0]);
}

async function init() {
  try {
    const [summary, orders, conversations] = await Promise.all([
      getJson('/api/summary'),
      getJson('/api/orders'),
      getJson('/api/conversations'),
    ]);
    renderMetrics(summary);
    renderOrders(orders);
    await renderConversations(conversations);
  } catch (error) {
    document.querySelector('#metrics').innerHTML = '<article class="metric-card"><strong>Demo data unavailable</strong><span class="metric-sub">Please refresh in a moment.</span></article>';
    document.querySelector('#orders').innerHTML = '<tr><td colspan="5" class="loading-row">Unable to load demo data.</td></tr>';
    document.querySelector('#chat-body').innerHTML = '<div class="chat-placeholder">Unable to load conversations.</div>';
  }
}

init();
