# StoreOS — Store Management System

A full-stack store management application with invoicing, inventory, purchases (with landing cost), cash book, and tax handling.

## Tech Stack
- **Backend**: Node.js + Express + MongoDB (Mongoose)
- **Frontend**: Vue 3 (CDN, no build step)

## Features
- 📋 **Invoicing** — Create invoices with product search, tax calculations (inclusive/exclusive), discounts, partial payments
- 📦 **Inventory Control** — Product management with cost/selling price, tax rate, stock levels, low-stock alerts, stock adjustments
- 🛒 **Purchases** — Purchase orders with landing cost distribution (freight, customs, etc.) automatically allocated to item unit costs
- 💵 **Cash Book** — Daily cash entries, running balance, category summaries
- 👥 **Customers** — Customer accounts with balance tracking
- 🏭 **Suppliers** — Supplier accounts with payable balances
- 📊 **Dashboard** — Today's sales, cash balance, outstanding receivables/payables, 7-day trend

## Setup

### Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)

### Install & Run

```bash
cd server
npm install
npm start
```

Open http://localhost:3000 in your browser.

### Using MongoDB Atlas (Cloud)
Edit `server/.env`:
```
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/storeapp
```

## Project Structure
```
store-app/
├── server/
│   ├── server.js          # Express app entry point
│   ├── .env               # Environment config
│   ├── package.json
│   ├── models/
│   │   ├── Product.js     # Inventory items
│   │   ├── Invoice.js     # Sales invoices
│   │   ├── Purchase.js    # Purchase orders
│   │   ├── Customer.js    # Customer accounts
│   │   ├── Supplier.js    # Supplier accounts
│   │   └── CashEntry.js   # Cash book entries
│   └── routes/
│       ├── products.js
│       ├── invoices.js    # Auto stock deduction, cash entries
│       ├── purchases.js   # Landing cost distribution, stock update
│       ├── customers.js
│       ├── suppliers.js
│       ├── cash.js        # Daily cash book with running balance
│       └── dashboard.js   # Aggregated stats
└── client/
    └── index.html         # Vue 3 SPA (no build needed)
```

## Landing Cost Calculation
When creating a purchase, add landing costs (freight, customs, handling fees). The system automatically distributes these costs proportionally by line value across all items, updating each product's `finalUnitCost` and the product's stored `costPrice` in inventory.

## Tax Handling
- Set tax rate (%) per product
- Choose Tax Exclusive (tax added on top) or Tax Inclusive per invoice
- Tax amounts shown separately in all reports
