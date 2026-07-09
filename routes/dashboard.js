const router = require('express').Router();
const Invoice     = require('../models/Invoice');
const Purchase    = require('../models/Purchase');
const Product     = require('../models/Product');
const CashAccount = require('../models/CashAccount');
const BankAccount = require('../models/BankAccount');
const Cheque      = require('../models/Cheque');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const today      = new Date(); today.setHours(0,0,0,0);
    const tomorrow   = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const todaySales = await Invoice.aggregate([{ $match: { type: 'invoice', date: { $gte: today, $lt: tomorrow } } },{ $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 }, paid: { $sum: '$paid' } } }]);
    const monthSales = await Invoice.aggregate([{ $match: { type: 'invoice', date: { $gte: monthStart } } },{ $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }]);

    const inventoryStats = await Product.aggregate([{ $match: { active: true } },{ $group: { _id: null, totalProducts: { $sum: 1 }, totalStock: { $sum: '$stock' }, lowStock: { $sum: { $cond: [{ $lte: ['$stock','$minStock'] }, 1, 0] } }, totalValue: { $sum: { $multiply: ['$stock','$costPrice'] } } } }]);
    const outstanding    = await Invoice.aggregate([{ $match: { type: 'invoice', balance: { $gt: 0 } } },{ $group: { _id: null, total: { $sum: '$balance' }, count: { $sum: 1 } } }]);
    const outstandingPO  = await Purchase.aggregate([{ $match: { balance: { $gt: 0 } } },{ $group: { _id: null, total: { $sum: '$balance' }, count: { $sum: 1 } } }]);

    const recentInvoices = await Invoice.find({ type: 'invoice' }).sort({ date: -1 }).limit(5).populate('customer','name');

    const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(sevenDaysAgo.getDate()-6);
    const salesTrend = await Invoice.aggregate([{ $match: { type: 'invoice', date: { $gte: sevenDaysAgo } } },{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, total: { $sum: '$total' }, count: { $sum: 1 } } },{ $sort: { _id: 1 } }]);

    // Cash accounts
    const cashAccounts = await CashAccount.find({ active: true }).select('name currentBalance');
    const bankAccounts = await BankAccount.find({ active: true }).select('name currentBalance');
    const totalCash    = cashAccounts.reduce((s, a) => s + a.currentBalance, 0);
    const totalBank    = bankAccounts.reduce((s, a) => s + a.currentBalance, 0);

    // Pending cheques (due in 7 days)
    const soon = new Date(today); soon.setDate(soon.getDate() + 7);
    const pendingCheques = await Cheque.find({ dueDate: { $gte: today, $lte: soon }, status: { $in: ['pending','deposited'] } }).sort({ dueDate: 1 });

    // Estimated VAT payable (this month)
    const vatInv = await Invoice.aggregate([{ $match: { type: 'invoice', date: { $gte: monthStart }, status: { $ne: 'draft' } } },{ $group: { _id: null, outputVAT: { $sum: '$vatAmount' } } }]);
    const vatPur = await Purchase.aggregate([{ $match: { date: { $gte: monthStart }, status: { $ne: 'draft' } } },{ $group: { _id: null, inputVAT: { $sum: '$vatInputAmount' } } }]);
    const vatPayable = (vatInv[0]?.outputVAT||0) - (vatPur[0]?.inputVAT||0);

    res.json({
      today: {
        sales: todaySales[0] || { total: 0, count: 0, paid: 0 },
        cashIn: 0, cashOut: 0, netCash: 0
      },
      month: { sales: monthSales[0] || { total: 0, count: 0 } },
      cashBalance: totalCash,
      bankBalance: totalBank,
      vatPayable,
      inventory: inventoryStats[0] || { totalProducts:0, totalStock:0, lowStock:0, totalValue:0 },
      outstanding: outstanding[0] || { total:0, count:0 },
      outstandingPurchases: outstandingPO[0] || { total:0, count:0 },
      cashAccounts,
      bankAccounts,
      pendingCheques,
      recentInvoices,
      salesTrend
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
