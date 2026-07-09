document.addEventListener('DOMContentLoaded',function(){
const {createApp,ref,computed,watch,onMounted}=Vue;
createApp({setup(){
const today=new Date().toISOString().slice(0,10);
const d=new Date();
const todayStr=String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear();
const tok=ref(localStorage.getItem('sos_tok')||'');
const me=ref(JSON.parse(localStorage.getItem('sos_me')||'null'));
const lf=ref({u:'',p:''});const lerr=ref('');const lding=ref(false);const spwd=ref(false);
const pw=ref({cur:'',nw:'',cf:''});const pwErr=ref('');const pwOk=ref('');
function can(r){const o=['viewer','cashier','manager','admin'];return o.indexOf(me.value?.role)>=o.indexOf(r);}
async function login(){
  lerr.value='';if(!lf.value.u||!lf.value.p){lerr.value='Enter username and password';return;}
  lding.value=true;
  try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:lf.value.u,password:lf.value.p})});
    const data=await r.json();if(!r.ok){lerr.value=data.error||'Login failed';lding.value=false;return;}
    tok.value=data.token;me.value=data.user;localStorage.setItem('sos_tok',data.token);localStorage.setItem('sos_me',JSON.stringify(data.user));
    lf.value={u:'',p:''};loadDash();loadTxRates();loadCas();loadInvTypes();loadLocs();
  }catch(e){lerr.value='Connection error. Is the server running?';}
  lding.value=false;
}
function logout(){tok.value='';me.value=null;localStorage.removeItem('sos_tok');localStorage.removeItem('sos_me');pg.value='dash';}
async function changePw(){
  pwErr.value='';pwOk.value='';
  if(!pw.value.cur){pwErr.value='Enter current password';return;}
  if(pw.value.nw!==pw.value.cf){pwErr.value='Passwords do not match';return;}
  if(pw.value.nw.length<6){pwErr.value='Min 6 characters';return;}
  saving.value=true;
  try{await api('POST','/auth/change-password',{currentPassword:pw.value.cur,newPassword:pw.value.nw});pwOk.value='Password changed!';}catch(e){pwErr.value=e.message;}
  saving.value=false;
}
const pg=ref('dash');const saving=ref(false);const mErr=ref('');
// Safe number conversion — treats empty/null/NaN as 0
function n(v){
  if(v===null||v===undefined||v===''||v==='-'||v==='.'||v==='-.')return 0;
  const x=parseFloat(String(v));
  return isNaN(x)||!isFinite(x)?0:x;
}

async function api(method,path,body){
  try{
    const o={method,headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok.value}};
    if(body)o.body=JSON.stringify(body);
    const r=await fetch('/api'+path,o);
    if(r.status===401){logout();throw new Error('Session expired - please log in again');}
    if(r.status===404){throw new Error('Not found');}
    let data={};
    try{data=await r.json();}catch(je){if(!r.ok)throw new Error('Server error: '+r.statusText);}
    if(!r.ok)throw new Error(data.error||data.message||'Request failed ('+r.status+')');
    return data;
  }catch(e){
    if(e.message==='Failed to fetch'||e.name==='TypeError'){
      throw new Error('Cannot reach server — check your connection');
    }
    throw e;
  }
}
const dash=ref({});const prods=ref([]);const invs=ref([]);const pos=ref([]);
const custs=ref([]);const supps=ref([]);const cats=ref([]);
const txRates=ref([]);const allTxRates=ref([]);const taxRpt=ref({});
const users=ref([]);const invTypes=ref([]);const locs=ref([]);
const cas=ref([]);const xfers=ref([]);const exps=ref([]);const exSumm=ref([]);const expCats=ref([]);
const cashLedgerAcc=ref(null);const cashLedRows=ref([]);const cashLedFr=ref('');const cashLedTo=ref('');
const baccs=ref([]);const btxs=ref([]);const btab=ref('accounts');const btf=ref({acc:'',typ:'',fr:'',to:''});
const chqs=ref([]);const chqf=ref({dir:'',sts:''});
const ledDays=ref([]);const trial=ref({rows:[],grandDebit:0,grandCredit:0});
const ledV=ref('daily');const ledFr=ref(new Date(d.getFullYear(),d.getMonth(),1).toISOString().slice(0,10));
const ledTo=ref(today);const ledAccList=ref([]);const ledAcc=ref('');const accLedRows=ref([]);
const txFr=ref(new Date(d.getFullYear(),d.getMonth(),1).toISOString().slice(0,10));const txTo=ref(today);
const mTaxDetail=ref(false);const taxDetailData=ref({});
const txYear=ref(d.getFullYear());const txYears=[0,1,2,3,4].map(i=>d.getFullYear()-i);const curYear=d.getFullYear();const curMonth=d.getMonth()+1;
const txMonthly=ref({months:[],totals:null});
const rpt=ref({});const rptDate=ref(today);const rptTab=ref('trad');
// ── THEME ──────────────────────────────────────────────────────────────────
const isDark=ref(true);
function toggleTheme(){
  isDark.value=!isDark.value;
  document.documentElement.setAttribute('data-theme',isDark.value?'dark':'light');
  localStorage.setItem('storeos_theme',isDark.value?'dark':'light');
}
// Apply saved theme on load
(function(){const t=localStorage.getItem('storeos_theme');if(t==='light'){isDark.value=false;document.documentElement.setAttribute('data-theme','light');}})();

// ── COMPANY SETTINGS ────────────────────────────────────────────────────────
const mCoSettings=ref(false);
const coSettings=ref(JSON.parse(localStorage.getItem('storeos_co')||'{"name":"","address":"","phone":"","email":"","tin":"","vrn":"","website":"","footer":"Thank you for your business!","logoUrl":""}'));
function saveCoSettings(){localStorage.setItem('storeos_co',JSON.stringify(coSettings.value));mCoSettings.value=false;}

// ── JOURNAL ENTRY (direct posting to ledger accounts) ───────────────────────
const mJournalEntry=ref(false);
const eJournalEntry=ref({});
function openJournalEntry(account){
  if(!cas.value.length) loadCas();
  if(!baccs.value.length) loadBaccs();
  eJournalEntry.value={
    accountId: account._id,
    accountName: account.name,
    accountType: account.type,
    date: today,
    entryType: ['expense','asset'].includes(account.type) ? 'debit' : 'credit',
    amount: 0,
    description: '',
    reference: '',
    paymentMethod: '',
    cashAccount: '',
    bankAccount: '',
    chequeNo: ''
  };
  mErr.value='';
  mJournalEntry.value=true;
}
async function saveJournalEntry(){
  const e=eJournalEntry.value;
  if(!e.amount||e.amount<=0){mErr.value='Amount must be greater than 0';return;}
  if(!e.description){mErr.value='Description is required';return;}
  saving.value=true;mErr.value='';
  try{
    const narration=e.description+(e.reference?' Ref:'+e.reference:'');

    // DOUBLE ENTRY — always post both sides so every account is updated
    // Side 1: the selected ledger account (e.g. Stationary)
    await api('POST','/ledger-accounts/'+e.accountId+'/entries',{
      date:e.date, account:e.accountName, accountType:e.accountType,
      debit:  e.entryType==='debit'  ? e.amount : 0,
      credit: e.entryType==='credit' ? e.amount : 0,
      description:narration, reference:e.reference||'', sourceType:'journal'
    });

    // Side 2: the cash/bank account (opposite side of the entry)
    // This makes it appear in the cash/bank statement automatically
    if(e.paymentMethod==='cash'&&e.cashAccount){
      const cashAcc=cas.value.find(c=>c._id===e.cashAccount);
      const cashName='Cash - '+(cashAcc?.name||'Cash');
      // Debit on expense = cash goes OUT = credit the cash account
      // Credit on income  = cash comes IN = debit the cash account
      const cashDebit  = e.entryType==='credit' ? e.amount : 0;
      const cashCredit = e.entryType==='debit'  ? e.amount : 0;
      await api('POST','/ledger-accounts/'+e.accountId+'/entries',{
        date:e.date, account:cashName, accountType:'cash',
        debit:cashDebit, credit:cashCredit,
        description:narration, reference:e.reference||'', sourceType:'journal',
        linkedCashAccount:e.cashAccount
      });
      // Adjust actual balance
      const delta = e.entryType==='debit' ? -e.amount : e.amount;
      await api('PUT','/cash-accounts/'+e.cashAccount+'/adjust',{amount:delta,description:narration});
      loadCas();
    } else if(e.paymentMethod==='bank'&&e.bankAccount){
      const bankAcc=baccs.value.find(b=>b._id===e.bankAccount);
      const bankName='Bank - '+(bankAcc?.name||'Bank');
      const bankDebit  = e.entryType==='credit' ? e.amount : 0;
      const bankCredit = e.entryType==='debit'  ? e.amount : 0;
      await api('POST','/ledger-accounts/'+e.accountId+'/entries',{
        date:e.date, account:bankName, accountType:'bank',
        debit:bankDebit, credit:bankCredit,
        description:narration, reference:e.reference||'', sourceType:'journal',
        linkedBankAccount:e.bankAccount
      });
      const delta = e.entryType==='debit' ? -e.amount : e.amount;
      await api('PUT','/banking/accounts/'+e.bankAccount+'/adjust',{amount:delta,description:narration});
      loadBaccs();
    }
    mJournalEntry.value=false;
    // Refresh ledger detail if open
    if(mLedgerAccDetail.value&&ledgerAccDetail.value.account?._id){
      await viewLedgerAcc(ledgerAccDetail.value.account._id);
    }
    if(rpt.value&&rpt.value.date) loadRpt();
  }catch(err){mErr.value=err.message;}
  saving.value=false;
}

// ── CASH ACCOUNT ENTRY EDIT / DELETE ────────────────────────────────────────
const selectedCashRow=ref(null);
const mEditCashEntry=ref(false);
const eCashEntry=ref({});

function editCashEntry(row){
  const d=new Date(row.date);
  const dateStr=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  eCashEntry.value={
    accountId: cashLedgerAcc.value?._id || cashLedgerAcc.value,  // current cash account
    source: row.source,
    sourceId: row.sourceId,
    date: dateStr,
    amount: row.amount,
    description: row.description
  };
  mErr.value='';
  mEditCashEntry.value=true;
}

async function saveCashEntry(){
  const e=eCashEntry.value;
  if(!e.amount||e.amount<=0){mErr.value='Amount must be greater than 0';return;}
  saving.value=true;mErr.value='';
  try{
    const accId=e.accountId?._id||e.accountId;
    await api('PUT','/cash-accounts/'+accId+'/entries/'+e.source+'/'+e.sourceId,{
      amount:e.amount, description:e.description, date:e.date
    });
    mEditCashEntry.value=false;
    loadCashLedger(); loadCas();
  }catch(err){mErr.value=err.message;}
  saving.value=false;
}

async function delCashEntry(row){
  const label = row.source==='expense' ? 'this expense' : 'this journal entry';
  if(!confirm('Delete '+label+'? This will restore the cash balance and cannot be undone.'))return;
  try{
    await api('DELETE','/cash-accounts/'+(cashLedgerAcc.value?._id||cashLedgerAcc.value)+'/entries/'+row.source+'/'+row.sourceId);
    loadCashLedger(); loadCas();
  }catch(e){alert(e.message);}
}

// ── LEDGER ENTRY EDIT / DELETE ──────────────────────────────────────────────
const mEditLedgerEntry=ref(false);
const eEditLedgerEntry=ref({});

function editLedgerEntry(entry){
  const d=new Date(entry.date);
  const dateStr=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  eEditLedgerEntry.value={
    _id: entry._id,
    date: dateStr,
    description: entry.description,
    reference: entry.reference||'',
    debit: entry.debit||0,
    credit: entry.credit||0,
    amount: entry.debit||entry.credit||0
  };
  mErr.value='';
  mEditLedgerEntry.value=true;
}
async function saveLedgerEntry(){
  const e=eEditLedgerEntry.value;
  if(!e.amount||e.amount<=0){mErr.value='Amount must be greater than 0';return;}
  if(!e.description){mErr.value='Description required';return;}
  saving.value=true;mErr.value='';
  try{
    const update={
      date:e.date,description:e.description,reference:e.reference||'',
      debit: e.debit>0?e.amount:0,
      credit: e.credit>0?e.amount:0
    };
    await api('PUT','/ledger-accounts/entries/'+e._id,update);
    mEditLedgerEntry.value=false;
    // Refresh the account detail view
    if(ledgerAccDetail.value.account?._id) await viewLedgerAcc(ledgerAccDetail.value.account._id);
  }catch(err){mErr.value=err.message;}
  saving.value=false;
}
async function delLedgerEntry(entryId){
  if(!confirm('Delete this journal entry? This cannot be undone.'))return;
  try{
    await api('DELETE','/ledger-accounts/entries/'+entryId);
    // Refresh
    if(ledgerAccDetail.value.account?._id) await viewLedgerAcc(ledgerAccDetail.value.account._id);
  }catch(e){alert(e.message);}
}

// ── QUICK JOURNAL ENTRY (from Daily Report balance sheet) ──────────────────
const mQuickJournal=ref(false);
const eQuickJournal=ref({});

// Group ledger accounts by type for the select optgroups
const qjAccountGroups=computed(()=>{
  const order=['asset','liability','equity','income','expense'];
  const labels={asset:'Assets',liability:'Liabilities',equity:'Equity',income:'Income',expense:'Expenses'};
  const groups={};
  for(const a of ledgerAccs.value){
    if(!groups[a.type])groups[a.type]={type:a.type,label:labels[a.type]||a.type,items:[]};
    groups[a.type].items.push(a);
  }
  return order.filter(t=>groups[t]).map(t=>groups[t]);
});

function openQuickJournal(){
  eQuickJournal.value={
    date:rptDate.value||today,
    entryType:'expense',
    amount:0,
    debitAccountId:'',debitAccountName:'',
    creditAccountId:'',creditAccountName:'',
    paymentMethod:'',cashAccount:'',bankAccount:'',chequeNo:'',
    description:'',reference:''
  };
  mErr.value='';
  if(!ledgerAccs.value.length) loadLedgerAccs();
  if(!cas.value.length) loadCas();
  if(!baccs.value.length) loadBaccs();
  mQuickJournal.value=true;
}
function onQJTypeChange(){
  // Reset account selections when switching type
  eQuickJournal.value.debitAccountId='';
  eQuickJournal.value.debitAccountName='';
  eQuickJournal.value.creditAccountId='';
  eQuickJournal.value.creditAccountName='';
}
function onQJDebitChange(){
  const acc=ledgerAccs.value.find(a=>a._id===eQuickJournal.value.debitAccountId);
  eQuickJournal.value.debitAccountName=acc?acc.name:'';
}
function onQJCreditChange(){
  const acc=ledgerAccs.value.find(a=>a._id===eQuickJournal.value.creditAccountId);
  eQuickJournal.value.creditAccountName=acc?acc.name:'';
}
async function saveQuickJournal(){
  const e=eQuickJournal.value;
  if(!e.amount||e.amount<=0){mErr.value='Amount must be greater than 0';return;}
  if(!e.description){mErr.value='Description is required';return;}
  mErr.value='';

  // Resolve debit/credit based on entry type — user only picks ONE side
  let debitName='', creditName='';
  const payAcc = e.paymentMethod==='cash'
    ? cas.value.find(c=>c._id===e.cashAccount)
    : e.paymentMethod==='bank'
      ? baccs.value.find(b=>b._id===e.bankAccount)
      : null;

  if(e.entryType==='expense'){
    if(!e.debitAccountId){mErr.value='Select an expense account';return;}
    if(!e.paymentMethod){mErr.value='Select how it was paid';return;}
    debitName = e.debitAccountName;
    creditName = payAcc ? (e.paymentMethod==='cash'?'Cash - ':'Bank - ')+payAcc.name
               : e.paymentMethod==='credit' ? 'Accounts Payable'
               : e.paymentMethod==='cheque' ? 'Cheque Payments'
               : e.paymentMethod;
  } else if(e.entryType==='income'){
    if(!e.creditAccountId){mErr.value='Select an income account';return;}
    if(!e.paymentMethod){mErr.value='Select where it was received';return;}
    creditName = e.creditAccountName;
    debitName  = payAcc ? (e.paymentMethod==='cash'?'Cash - ':'Bank - ')+payAcc.name
               : e.paymentMethod==='credit' ? 'Accounts Receivable'
               : e.paymentMethod;
  } else {
    // Manual
    if(!e.debitAccountId){mErr.value='Select a debit account';return;}
    if(!e.creditAccountId){mErr.value='Select a credit account';return;}
    if(e.debitAccountId===e.creditAccountId){mErr.value='Debit and credit must be different';return;}
    debitName  = e.debitAccountName;
    creditName = e.creditAccountName;
  }

  saving.value=true;
  try{
    const narration = e.description + (e.reference?' Ref:'+e.reference:'');
    const debitAccId  = e.entryType==='expense'||e.entryType==='manual' ? e.debitAccountId  : null;
    const creditAccId = e.entryType==='income' ||e.entryType==='manual' ? e.creditAccountId : null;
    const debitType   = debitAccId  ? ledgerAccs.value.find(a=>a._id===debitAccId)?.type||'expense' : 'expense';
    const creditType  = creditAccId ? ledgerAccs.value.find(a=>a._id===creditAccId)?.type||'income' : 'income';

    if(debitAccId){
      await api('POST','/ledger-accounts/'+debitAccId+'/entries',{
        date:e.date, account:debitName, accountType:debitType,
        debit:e.amount, credit:0, description:narration, reference:e.reference||'', sourceType:'journal'
      });
    } else {
      // No ledger account for debit side (auto cash/bank) — just post a note
    }
    if(creditAccId){
      await api('POST','/ledger-accounts/'+creditAccId+'/entries',{
        date:e.date, account:creditName, accountType:creditType,
        debit:0, credit:e.amount, description:narration, reference:e.reference||'', sourceType:'journal'
      });
    }
    // Adjust cash/bank balance AND post the cash/bank side as a Ledger entry
    // so it appears in the cash/bank statement automatically
    if(e.paymentMethod==='cash'&&e.cashAccount){
      const cashAcc=cas.value.find(c=>c._id===e.cashAccount);
      const cashName='Cash - '+(cashAcc?.name||'Cash');
      // For expense: cash goes OUT → credit cash; for income: cash comes IN → debit cash
      const cashDebit  = e.entryType==='income'  ? e.amount : 0;
      const cashCredit = e.entryType==='expense'  ? e.amount : 0;
      // Only post if we have a real account ID for debit/credit
      const postToId = e.entryType==='expense' ? e.debitAccountId
                     : e.entryType==='income'  ? e.creditAccountId : null;
      if(postToId){
        await api('POST','/ledger-accounts/'+postToId+'/entries',{
          date:e.date, account:cashName, accountType:'cash',
          debit:cashDebit, credit:cashCredit,
          description:narration, reference:e.reference||'', sourceType:'journal'
        });
      }
      const delta = e.entryType==='expense' ? -e.amount : e.amount;
      await api('PUT','/cash-accounts/'+e.cashAccount+'/adjust',{amount:delta,description:narration});
      loadCas();
    } else if(e.paymentMethod==='bank'&&e.bankAccount){
      const bankAcc=baccs.value.find(b=>b._id===e.bankAccount);
      const bankName='Bank - '+(bankAcc?.name||'Bank');
      const bankDebit  = e.entryType==='income'  ? e.amount : 0;
      const bankCredit = e.entryType==='expense'  ? e.amount : 0;
      const postToId = e.entryType==='expense' ? e.debitAccountId
                     : e.entryType==='income'  ? e.creditAccountId : null;
      if(postToId){
        await api('POST','/ledger-accounts/'+postToId+'/entries',{
          date:e.date, account:bankName, accountType:'bank',
          debit:bankDebit, credit:bankCredit,
          description:narration, reference:e.reference||'', sourceType:'journal'
        });
      }
      const delta = e.entryType==='expense' ? -e.amount : e.amount;
      await api('PUT','/banking/accounts/'+e.bankAccount+'/adjust',{amount:delta,description:narration});
      loadBaccs();
    }
    mQuickJournal.value=false;
    if(rpt.value&&rpt.value.date) loadRpt();
  }catch(err){mErr.value=err.message;}
  saving.value=false;
}

// ── LEDGER ACCOUNTS (Chart of Accounts) ─────────────────────────────────────
const ledgerAccs=ref([]);
const mLedgerAcc=ref(false);
const eLedgerAcc=ref({});
const mLedgerAccDetail=ref(false);
const ledgerAccDetail=ref({});
const trialBalance=ref({accounts:[],totalDr:0,totalCr:0,balanced:true});
const expAccFilter=ref('');

const ledgerAccsByType=computed(()=>{
  const typeOrder=['expense','income','asset','liability','equity'];
  const labels={expense:'Expenses',income:'Income',asset:'Assets',liability:'Liabilities',equity:'Equity'};
  const groups={};
  for(const a of ledgerAccs.value){
    if(!groups[a.type])groups[a.type]={type:a.type,label:labels[a.type]||a.type,items:[]};
    groups[a.type].items.push(a);
  }
  return typeOrder.filter(t=>groups[t]).map(t=>groups[t]);
});

async function loadLedgerAccs(){
  try{ledgerAccs.value=await api('GET','/ledger-accounts?active=all');}catch(e){console.error('loadLedgerAccs:',e.message);}
}
function openLedgerAcc(a){
  eLedgerAcc.value=a&&a._id?{...a}:{name:'',code:'',type:(a&&a.type)||'expense',description:'',openingBalance:0};
  mErr.value='';mLedgerAcc.value=true;
}
async function saveLedgerAcc(){
  if(!eLedgerAcc.value.name){mErr.value='Account name is required';return;}
  if(!eLedgerAcc.value.type){mErr.value='Type is required';return;}
  try{
    if(eLedgerAcc.value._id) await api('PUT','/ledger-accounts/'+eLedgerAcc.value._id,eLedgerAcc.value);
    else await api('POST','/ledger-accounts',eLedgerAcc.value);
    mLedgerAcc.value=false;
    await loadLedgerAccs();
  }catch(e){mErr.value=e.message;}
}
async function delLedgerAcc(id){
  if(!confirm('Delete this account? Any past transactions will remain but no new ones can post here.'))return;
  try{await api('DELETE','/ledger-accounts/'+id);await loadLedgerAccs();}catch(e){alert(e.message);}
}
async function viewLedgerAcc(id){
  try{
    ledgerAccDetail.value=await api('GET','/ledger-accounts/'+id);
    mLedgerAccDetail.value=true;
  }catch(e){alert(e.message);}
}
async function loadTrialBalance(){
  try{trialBalance.value=await api('GET','/ledger-accounts/reports/trial-balance');}catch(e){console.error(e.message);}
}
function onLedgerAccChange(){
  const acc=ledgerAccs.value.find(a=>a._id===eExp.value.ledgerAccount);
  if(acc)eExp.value.ledgerAccountName=acc.name;
}

// ── PRINT INVOICE ────────────────────────────────────────────────────────────
const mPrintInv=ref(false);
const printInv=ref({});
const printTpl=ref('classic');
const printColor=ref('#2563eb');
const printShowTax=ref(true);
const printShowNotes=ref(true);
const invPreviewStyle=computed(()=>({background:'#fff',color:'#222',fontFamily:"'DM Sans',sans-serif",padding:'24px 28px',borderRadius:'8px',minHeight:'700px',boxShadow:'0 2px 20px rgba(0,0,0,.08)'}));

function printInvoice(inv){
  printInv.value={...inv};
  mPrintInv.value=true;
}
function doPrint(){
  // Save current body and replace with just print area
  const printContent = document.getElementById('inv-print-area').innerHTML;
  const originalBody = document.body.innerHTML;
  document.body.innerHTML = '<div style="padding:0;margin:0">'+printContent+'</div>';
  window.print();
  document.body.innerHTML = originalBody;
  window.location.reload();
}

// ── CATEGORIES ─────────────────────────────────────────────────────────────
const mCat=ref(false);
const eCat=ref({});
const savedCats=ref([]);
const pCatFilter=ref('');
async function loadSavedCats(){try{savedCats.value=await api('GET','/categories');}catch(e){}}
async function saveCat(){
  try{
    if(eCat.value._id) await api('PUT','/categories/'+eCat.value._id,eCat.value);
    else await api('POST','/categories',eCat.value);
    mCat.value=false;eCat.value={};await loadSavedCats();
    // If product modal open, refresh
  }catch(e){alert(e.message);}
}
async function delCat(id){if(!confirm('Delete this category?'))return;try{await api('DELETE','/categories/'+id);await loadSavedCats();}catch(e){alert(e.message);}}
const prodsByCategory=computed(()=>{
  const groups={};
  for(const p of prods.value){
    const cat=p.category||'General';
    if(!groups[cat])groups[cat]={name:cat,items:[]};
    groups[cat].items.push(p);
  }
  return Object.values(groups).sort((a,b)=>a.name.localeCompare(b.name));
});

// ── QUICK PRODUCT (create product without closing PO modal) ────────────────
const mQuickProd=ref(false);
function openQuickProd(){eProd.value={name:'',sku:'',category:'',unit:'pcs',costPrice:0,sellingPrice:0,stock:0,minStock:0,description:'',defaultTaxCodes:[],locationStock:[],allowLoose:false,looseUnit:'',looseConversion:1,looseSellingPrice:0};mErr.value='';mQuickProd.value=true;}
async function saveQuickProd(){
  saving.value=true;mErr.value='';
  try{
    const p=await api('POST','/products',eProd.value);
    prods.value=[...prods.value,p].sort((a,b)=>a.name.localeCompare(b.name));
    mQuickProd.value=false;
    // Auto-add to PO search results
    poSrchRes.value=[p,...poSrchRes.value];
  }catch(e){mErr.value=e.message;}
  saving.value=false;
}

const mStockMovement=ref(false);
const stockMovementData=ref({product:null,movements:[]});
async function viewStockMovement(productId){
  try{
    stockMovementData.value=await api('GET','/products/'+productId+'/movements');
    mStockMovement.value=true;
  }catch(e){alert(e.message);}
}

const mPODetail=ref(false);const poDet=ref({});const newStage=ref({});
const poDetSrch=ref('');const poDetSrchRes=ref([]);const poDetNewLC=ref({});
const mInvDetail=ref(false);const invDet=ref({});
const mReturn=ref(false);const retInv=ref({});const retItems=ref([]);const retTotal=ref(0);const retReason=ref('');const retDate=ref(new Date().toISOString().slice(0,10));const retRestock=ref(true);
const poFinFilt=ref('');
const psrch=ref('');const ifilt=ref('');const pofilt=ref('');
const exFrom=ref(new Date(d.getFullYear(),d.getMonth(),1).toISOString().slice(0,10));const exTo=ref(today);
const suppHist=ref({});
const stmtAcc=ref(null);const stmtFr=ref('');const stmtTo=ref('');const stmtRows=ref([]);
const mProd=ref(false);const mStk=ref(false);const mCust=ref(false);const mSupp=ref(false);const mSuppH=ref(false);
const mCA=ref(false);const mXfer=ref(false);const mExp=ref(false);const mPay=ref(false);
const mTxRate=ref(false);const mInvType=ref(false);const mLoc=ref(false);const mUser=ref(false);
const mBAcc=ref(false);const mBTx=ref(false);const mStmt=ref(false);const mChq=ref(false);const mChqSts=ref(false);
const mInv=ref(false);const mPO=ref(false);
const eProd=ref({});const eStk=ref({});const eCust=ref({});const eSupp=ref({});
const eCA=ref({});const eXfer=ref({});const eExp=ref({});
const eTxRate=ref({});const eInvType=ref({});const eLoc=ref({});const eUser=ref({});
const PERM_GROUPS=[
  {label:'Sales',keys:[['invoices','Invoices'],['customers','Customers']]},
  {label:'Purchasing',keys:[['purchases','Purchases'],['suppliers','Suppliers']]},
  {label:'Stock',keys:[['inventory','Inventory']]},
  {label:'Accounts',keys:[['cashAccounts','Cash Accounts'],['expenses','Expenses'],['banking','Banking'],['cheques','Cheques'],['ledger','Ledger'],['chartOfAccounts','Chart of Accounts'],['trialBalance','Trial Balance']]},
  {label:'Reports',keys:[['dailyReport','Daily Report'],['taxReport','Tax Report'],['monthlyTax','Monthly Tax']]},
  {label:'Setup',keys:[['invoiceSettings','Invoice Settings'],['locations','Locations'],['taxRates','Tax Rates'],['userManagement','User Management']]},
  {label:'Other',keys:[['canDeleteRecords','Can Delete Records'],['canEditPastEntries','Can Edit Past Entries']]}
];
const ROLE_DEFAULTS={
  admin:{dashboard:true,invoices:true,customers:true,purchases:true,suppliers:true,inventory:true,cashAccounts:true,expenses:true,banking:true,cheques:true,ledger:true,chartOfAccounts:true,trialBalance:true,dailyReport:true,taxReport:true,monthlyTax:true,invoiceSettings:true,locations:true,taxRates:true,userManagement:true,canDeleteRecords:true,canEditPastEntries:true},
  manager:{dashboard:true,invoices:true,customers:true,purchases:true,suppliers:true,inventory:true,cashAccounts:true,expenses:true,banking:true,cheques:true,ledger:true,chartOfAccounts:true,trialBalance:true,dailyReport:true,taxReport:true,monthlyTax:true,invoiceSettings:false,locations:false,taxRates:false,userManagement:false,canDeleteRecords:false,canEditPastEntries:true},
  cashier:{dashboard:true,invoices:true,customers:true,purchases:false,suppliers:false,inventory:true,cashAccounts:true,expenses:false,banking:false,cheques:false,ledger:false,chartOfAccounts:false,trialBalance:false,dailyReport:false,taxReport:false,monthlyTax:false,invoiceSettings:false,locations:false,taxRates:false,userManagement:false,canDeleteRecords:false,canEditPastEntries:false},
  viewer:{dashboard:true,invoices:false,customers:false,purchases:false,suppliers:false,inventory:true,cashAccounts:false,expenses:false,banking:false,cheques:false,ledger:false,chartOfAccounts:false,trialBalance:false,dailyReport:false,taxReport:false,monthlyTax:false,invoiceSettings:false,locations:false,taxRates:false,userManagement:false,canDeleteRecords:false,canEditPastEntries:false}
};
function applyRoleDefaults(){eUser.value.permissions={...(ROLE_DEFAULTS[eUser.value.role]||ROLE_DEFAULTS.cashier)};}
const eBAcc=ref({});const eBTx=ref({});const eChq=ref({});const chqStsData=ref({});
const payDoc=ref(null);const payAmt=ref(0);const payMode=ref('cash');const payCashAcc=ref('');const payBankAcc=ref('');const payChqNo=ref('');const payDate=ref(today);
const iSrch=ref('');const iSrchRes=ref([]);const iSrchLoading=ref(false);const poSrch=ref('');const poSrchRes=ref([]);
const invNoPreview=ref('');
function fInv(){return{customer:'',customerName:'Walk-in Customer',customerTin:'',date:today,dueDate:'',taxInclusive:false,taxInvoice:false,invoiceType:'',invoiceTypeName:'',invTypeTaxConfig:[],toggledTaxes:{},items:[],subtotal:0,taxAmount:0,taxBreakdown:[],discount:0,total:0,paid:0,balance:0,paymentMode:'cash',cashAccount:'',bankAccount:'',chequeNo:'',notes:''};} 
const nInv=ref(fInv());
function fPO(type){return{purchaseType:type||'local',supplier:'',supplierName:'',date:today,currency:'USD',exchangeRate:300,items:[],landingCosts:[],subtotalForeign:0,subtotal:0,taxAmount:0,landingCostTotal:0,total:0,paid:0,balance:0,paymentMode:'cash',updateStock:true,taxInclusive:false,notes:''};} 
const nPO=ref(fPO());
const tdate=computed(()=>new Date().toLocaleDateString('en-GB',{weekday:'long',year:'numeric',month:'long',day:'numeric'}));
const lowStock=computed(()=>prods.value.filter(p=>p.stock<=p.minStock).length);
const pendChq=computed(()=>chqs.value.filter(c=>c.status==='pending'&&new Date(c.dueDate)<=new Date(Date.now()+7*86400000)).length);
const trialGrp=computed(()=>{const g={};for(const r of trial.value.rows||[]){if(!g[r.accountType])g[r.accountType]={type:r.accountType,rows:[]};g[r.accountType].rows.push(r);}return Object.values(g);});
const f=n=>Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const fd=d=>d?new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):'—';
const fdL=d=>new Date(d).toLocaleDateString('en-GB',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
const bp=(v,arr)=>{if(!arr?.length)return 0;const mx=Math.max(...arr.map(d=>d.total));return mx?(v/mx*100):0;};
const bs=s=>({pending:'bpend',partial:'bpart',paid:'bpaid',overdue:'bover',draft:'bdrft',received:'brcvd'}[s]||'bdrft');
const chqSC=s=>({pending:'bpend',deposited:'bpart',cleared:'bpaid',bounced:'bover',cancelled:'bdrft'}[s]||'bdrft');
const chqDue=c=>['pending','deposited'].includes(c.status)&&new Date(c.dueDate)<=new Date(Date.now()+3*86400000);
async function loadDash(){try{dash.value=await api('GET','/dashboard');}catch(e){}}
async function loadProds(){try{prods.value=await api('GET','/products?search='+psrch.value);}catch(e){}}
async function loadCats(){try{cats.value=await api('GET','/products/meta/categories');}catch(e){}}
async function loadTxRates(){try{txRates.value=await api('GET','/tax');}catch(e){}}
async function loadAllTxRates(){try{allTxRates.value=await api('GET','/tax/all');}catch(e){}}
async function loadInvs(){try{invs.value=await api('GET','/invoices?status='+ifilt.value);}catch(e){}}
async function loadPOs(){try{let q='/purchases?purchaseType='+pofilt.value;if(poFinFilt.value==='open')q+='&isFinalized=false';if(poFinFilt.value==='finalized')q+='&isFinalized=true';pos.value=await api('GET',q);}catch(e){}}
async function loadCusts(){try{custs.value=await api('GET','/customers');}catch(e){}}
async function loadSupps(){try{supps.value=await api('GET','/suppliers');}catch(e){}}
async function loadCas(){try{cas.value=await api('GET','/cash-accounts');}catch(e){}}
async function loadXfers(){try{xfers.value=await api('GET','/cash-accounts/transfers');}catch(e){}}
async function loadExps(){try{let q='/expenses';const p=[];if(exFrom.value)p.push('from='+exFrom.value);if(exTo.value)p.push('to='+exTo.value);if(expAccFilter.value)p.push('ledgerAccount='+encodeURIComponent(expAccFilter.value));if(p.length)q+='?'+p.join('&');exps.value=await api('GET',q);}catch(e){}}
async function loadExpCats(){try{expCats.value=await api('GET','/expenses/categories');}catch(e){}}
async function loadInvTypes(){try{invTypes.value=await api('GET','/invoice-types');}catch(e){}}
async function loadLocs(){try{locs.value=await api('GET','/locations');}catch(e){}}
async function loadBaccs(){try{baccs.value=await api('GET','/banking/accounts');}catch(e){}}
async function loadBTxs(){try{const q=new URLSearchParams(Object.fromEntries(Object.entries(btf.value).filter(([,v])=>v)));btxs.value=await api('GET','/banking/transactions?'+q);}catch(e){}}
async function loadChqs(){try{const q=new URLSearchParams(Object.fromEntries(Object.entries(chqf.value).filter(([,v])=>v)));chqs.value=await api('GET','/cheques?'+q);}catch(e){}}
async function loadUsers(){try{users.value=await api('GET','/auth/users');}catch(e){}}
async function loadLed(){
  try{const q='from='+ledFr.value+'&to='+ledTo.value;
    if(ledV.value==='daily')ledDays.value=await api('GET','/ledger/daily?'+q);
    else if(ledV.value==='trial')trial.value=await api('GET','/ledger/trial-balance?'+q);
    else if(ledV.value==='account'){ledAccList.value=await api('GET','/ledger/accounts-list');if(ledAcc.value)await loadAccLed();}
  }catch(e){}
}
async function loadAccLed(){if(!ledAcc.value)return;try{const q='account='+encodeURIComponent(ledAcc.value)+'&from='+ledFr.value+'&to='+ledTo.value;accLedRows.value=await api('GET','/ledger/account?'+q);}catch(e){}}
async function loadTaxRpt(){try{taxRpt.value=await api('GET','/tax/report?from='+txFr.value+'&to='+txTo.value);}catch(e){}}
async function openTaxDetail(code){
  try{
    taxDetailData.value={code};mTaxDetail.value=true;
    const r=await api('GET','/tax/detail/'+code+'?from='+txFr.value+'&to='+txTo.value);
    taxDetailData.value=r;
  }catch(e){alert(e.message);}
}
async function loadTaxMonthly(){try{txMonthly.value=await api('GET','/tax/monthly?year='+txYear.value);}catch(e){}}
const expandedRptRows=ref(new Set());
function toggleRptRow(idx){
  const s=new Set(expandedRptRows.value);
  if(s.has(idx))s.delete(idx);else s.add(idx);
  expandedRptRows.value=s;
}
async function loadRpt(){if(!rptDate.value)return;expandedRptRows.value=new Set();try{rpt.value=await api('GET','/ledger/daily-cash-report?date='+rptDate.value);}catch(e){alert(e.message);}}
async function loadStmt(){try{const q='from='+stmtFr.value+'&to='+stmtTo.value;stmtRows.value=await api('GET','/banking/accounts/'+stmtAcc.value._id+'/statement?'+q);}catch(e){alert(e.message);}}
watch(pg,async p=>{
  if(p==='dash')loadDash();
  if(p==='stk'){loadProds();loadCats();loadTxRates();loadLocs();}
  if(p==='inv'){loadInvs();loadCusts();loadTxRates();}
  if(p==='po'){loadPOs();loadSupps();loadTxRates();}
  if(p==='cust')loadCusts();
  if(p==='sup')loadSupps();
  if(p==='cash'){loadCas();loadXfers();loadBaccs();}
  if(p==='exp'){loadExps();loadExpCats();loadCas();loadBaccs();}
  if(p==='bank'){loadBaccs();loadBTxs();}
  if(p==='chq'){loadChqs();loadBaccs();}
  if(p==='led'){loadLed();api('GET','/ledger/accounts-list').then(r=>ledAccList.value=r).catch(()=>{});}
  if(p==='drpt')loadRpt();
  if(p==='taxr')loadTaxRpt();
  if(p==='taxm')loadTaxMonthly();
  if(p==='txrt')loadAllTxRates();
  if(p==='invt')loadInvTypes();
  if(p==='loc'){loadLocs();loadProds();}
  if(p==='usr')loadUsers();
});
watch(ledV,()=>loadLed());
function openProd(p){eProd.value=p?{...p,defaultTaxCodes:[...(p.defaultTaxCodes||[])],locationStock:JSON.parse(JSON.stringify(p.locationStock||[])),allowLoose:p.allowLoose||false,looseUnit:p.looseUnit||'',looseConversion:p.looseConversion||1,looseSellingPrice:p.looseSellingPrice||0}:{name:'',sku:'',category:'',unit:'pcs',costPrice:0,sellingPrice:0,stock:0,minStock:0,description:'',defaultTaxCodes:[],locationStock:[],allowLoose:false,looseUnit:'',looseConversion:1,looseSellingPrice:0};mErr.value='';mProd.value=true;}
function addProdLoc(){const unused=locs.value.filter(l=>!eProd.value.locationStock?.some(ls=>ls.location?.toString()===l._id.toString()));if(!unused.length){alert('All locations added');return;}const l=unused[0];if(!eProd.value.locationStock)eProd.value.locationStock=[];eProd.value.locationStock.push({location:l._id,locationName:l.name,stock:0});}
async function saveProd(){if(!eProd.value.name){mErr.value='Name required';return;}saving.value=true;mErr.value='';try{if(eProd.value._id)await api('PUT','/products/'+eProd.value._id,eProd.value);else await api('POST','/products',eProd.value);mProd.value=false;loadProds();}catch(e){mErr.value=e.message;}saving.value=false;}
async function delProd(id){if(!confirm('Delete this product?'))return;try{await api('DELETE','/products/'+id);loadProds();}catch(e){alert(e.message);}}
function openStk(p){const ls=(p.locationStock||[]).map(l=>({...l,orig:l.stock}));eStk.value={product:{...p},adj:0,locationStock:ls,newTotal:p.stock||0};mStk.value=true;}
async function saveLocStk(){
  saving.value=true;
  try{
    const data={locationStock:eStk.value.locationStock.map(ls=>({location:ls.location,locationName:ls.locationName,stock:ls.stock||0}))};
    data.stock=data.locationStock.reduce((s,l)=>s+(l.stock||0),0);
    await api('PUT','/products/'+eStk.value.product._id,data);
    mStk.value=false;loadProds();
  }catch(e){alert(e.message);}
  saving.value=false;
}
async function saveStkAdj(){
  if(!eStk.value.adj&&!eStk.value.looseAdj){mStk.value=false;return;}
  saving.value=true;
  try{
    const adj = n(eStk.value.adj)||0;
    const looseAdj = n(eStk.value.looseAdj)||0;
    const prod = eStk.value.product;
    
    // Build update payload
    const update = {};
    if(adj!==0) update.stock = (prod.stock||0) + adj;
    if(looseAdj!==0) update.looseStock = (prod.looseStock||0) + looseAdj;
    
    // Normalize: if looseStock >= looseConversion, convert to full bags
    if(prod.allowLoose && prod.looseConversion>0 && update.looseStock!==undefined){
      const newLoose = update.looseStock;
      if(newLoose >= prod.looseConversion){
        const extraBags = Math.floor(newLoose/prod.looseConversion);
        update.looseStock = newLoose % prod.looseConversion;
        update.stock = (update.stock!==undefined?update.stock:prod.stock||0) + extraBags;
      }
      if(update.looseStock < 0){
        // Negative loose - borrow from bags
        const bagsNeeded = Math.ceil(Math.abs(update.looseStock)/prod.looseConversion);
        update.stock = (update.stock!==undefined?update.stock:prod.stock||0) - bagsNeeded;
        update.looseStock = (bagsNeeded*prod.looseConversion) + update.looseStock;
      }
    }
    
    await api('PUT','/products/'+prod._id, update);
    mStk.value=false;
    loadProds();
  }catch(e){alert(e.message);}
  saving.value=false;
}
function onCustChange(){const c=custs.value.find(c=>c._id===nInv.value.customer);nInv.value.customerName=c?c.name:'Walk-in Customer';nInv.value.customerTin=c?.tin||'';}
let _srchTimer=null;
async function previewInvNo(typeId){
  if(!typeId){invNoPreview.value='';return;}
  try{
    const it=invTypes.value.find(t=>t._id===typeId);
    if(it){invNoPreview.value=(it.prefix||'INV')+'-'+new Date().toLocaleDateString('en-GB').split('/').reverse().join('/')+'-XXXX';}
  }catch(e){}
}
function addFirstProd(){
  if(iSrchRes.value.length>0){addProdToInv(iSrchRes.value[0]);iSrch.value='';iSrchRes.value=[];}
}
function srchProds(){
  clearTimeout(_srchTimer);
  if(!iSrch.value.trim()){iSrchRes.value=[];iSrchLoading.value=false;return;}
  iSrchLoading.value=true;
  _srchTimer=setTimeout(async()=>{
    if(!iSrch.value.trim()){iSrchRes.value=[];iSrchLoading.value=false;return;}
    try{
      iSrchRes.value=await api('GET','/products?search='+encodeURIComponent(iSrch.value.trim()));
    }catch(e){console.error(e);}
    finally{iSrchLoading.value=false;}
  },150);
}

function addProdToInv(p){
  // Build default tax lines from product defaults + invoice type taxes
  const dtl=(p.defaultTaxCodes||[]).map(code=>{
    const tr=txRates.value.find(t=>t.code===code);
    return tr?{taxCode:tr.code,taxName:tr.name,rate:tr.rate,reducedBy:tr.reducedBy||[],businessTax:tr.businessTax||false,amount:0}:null;
  }).filter(Boolean);
  // Add active invoice-type taxes (always + toggled-on), avoiding duplicates
  for(const tc of nInv.value.invTypeTaxConfig||[]){
    if((tc.mode==='always'||nInv.value.toggledTaxes[tc.taxCode])&&!dtl.some(d=>d.taxCode===tc.taxCode)){
      const fullRate=txRates.value.find(t=>t.code===tc.taxCode);
      dtl.push({taxCode:tc.taxCode,taxName:tc.taxName,rate:tc.rate,reducedBy:fullRate?.reducedBy||[],businessTax:fullRate?.businessTax||false,amount:0});
    }
  }
  nInv.value.items.push({
    product:p._id,productName:p.name,sku:p.sku||'',qty:1,
    unit:p.unit||'pcs',unitPrice:p.sellingPrice||0,
    taxLines:dtl,taxAmount:0,lineSubtotal:0,lineTotal:0,
    allowLoose:p.allowLoose||false,looseMode:false,
    looseUnit:p.looseUnit||'',baseUnit:p.unit||'pcs',
    looseConversion:p.looseConversion||1,
    looseSellingPrice:p.looseSellingPrice||0,
    basePricePerUnit:p.sellingPrice||0
  });
  iSrch.value='';iSrchRes.value=[];
  calcInv();
}
function addTaxToLine(item,code){if(!code||item.taxLines.some(tl=>tl.taxCode===code))return;const tr=txRates.value.find(t=>t.code===code);if(!tr)return;item.taxLines.push({taxCode:tr.code,taxName:tr.name,rate:tr.rate,reducedBy:tr.reducedBy||[],businessTax:tr.businessTax||false,amount:0});calcInv();}

function toggleLooseMode(item){
  item.looseMode=!item.looseMode;
  if(item.looseMode){
    // LOOSE mode: quantity means loose units (e.g. kg)
    // e.g. qty=1 means 1kg, qty=0.5 means 500g
    item.unit=item.looseUnit||'unit';
    item.unitPrice=item.looseSellingPrice||(item.looseConversion>0?(item.basePricePerUnit/item.looseConversion):item.basePricePerUnit);
  }else{
    // FULL mode: quantity means base units (e.g. bags)
    // e.g. qty=1 means 1 bag (25kg)
    item.unit=item.baseUnit||'pcs';
    item.unitPrice=item.basePricePerUnit||item.unitPrice;
  }
  calcInv();
}
function calcInv(){try{
  if(!nInv.value||!Array.isArray(nInv.value.items))return;
  // businessTax=true: calculated on net for IRD reporting, NOT added to invoice total
  // businessTax=false: normal customer tax, included in/added to total
  // INCLUSIVE: customer taxes are INSIDE the entered price (e.g. VAT in 300,000)
  //   net = price / (1 + sum_customer_rates/100)
  //   lineTotal = entered price (unchanged)
  // EXCLUSIVE: customer taxes added on top
  //   lineTotal = price + customerTaxes
  // In BOTH modes: businessTax amount is calculated on net for IRD, never touches total
  let sub=0,totCustTax=0,totBizTax=0;
  const bd={};
  for(const item of nInv.value.items){
    item.lineSubtotal=n(item.qty)*n(item.unitPrice||0);
    const custTaxes=item.taxLines.filter(tl=>!tl.businessTax);
    const bizTaxes =item.taxLines.filter(tl=> tl.businessTax);
    const normal   =custTaxes.filter(tl=>!(tl.reducedBy&&tl.reducedBy.length));
    const reduced  =custTaxes.filter(tl=>  tl.reducedBy&&tl.reducedBy.length);
    let cTax=0,bTax=0;

    if(nInv.value.taxInclusive){
      // Extract customer taxes from inside the price
      const embRate=custTaxes.reduce((s,tl)=>s+tl.rate,0);
      const net=embRate?item.lineSubtotal/(1+embRate/100):item.lineSubtotal;
      for(const tl of custTaxes){
        const a=net*(tl.rate/100);tl.amount=a;cTax+=a;
        bd[tl.taxCode]={taxCode:tl.taxCode,taxName:tl.taxName,rate:tl.rate,businessTax:false,amount:(bd[tl.taxCode]?.amount||0)+a};
      }
      // Business taxes on net (reducedBy removes embedded customer taxes → base = net)
      for(const tl of bizTaxes){
        const p1=custTaxes.reduce((s,t)=>s+t.amount,0);
        const sub2=(tl.reducedBy||[]).reduce((s,c)=>{const f=custTaxes.find(t=>t.taxCode===c);return s+(f?f.amount:0);},0);
        const base=Math.max(0,(net+p1)-sub2);
        const a=base*(tl.rate/100);tl.amount=a;bTax+=a;
        bd[tl.taxCode]={taxCode:tl.taxCode,taxName:tl.taxName,rate:tl.rate,businessTax:true,amount:(bd[tl.taxCode]?.amount||0)+a};
      }
      item.lineTotal=item.lineSubtotal; // price unchanged — customer pays what they entered
    }else{
      // Exclusive: customer taxes added on top
      for(const tl of normal){const a=n(item.lineSubtotal)*(n(tl.rate)/100);tl.amount=a;cTax+=a;bd[tl.taxCode]={taxCode:tl.taxCode,taxName:tl.taxName,rate:tl.rate,businessTax:false,amount:(bd[tl.taxCode]?.amount||0)+a};}
      for(const tl of reduced){
        const p1=normal.reduce((s,t)=>s+t.amount,0);
        const sub2=(tl.reducedBy||[]).reduce((s,c)=>{const f=normal.find(t=>t.taxCode===c);return s+(f?f.amount:0);},0);
        const base=Math.max(0,(item.lineSubtotal+p1)-sub2);
        const a=base*(tl.rate/100);tl.amount=a;cTax+=a;
        bd[tl.taxCode]={taxCode:tl.taxCode,taxName:tl.taxName,rate:tl.rate,businessTax:false,amount:(bd[tl.taxCode]?.amount||0)+a};
      }
      // Business taxes calculated on net, NOT added to lineTotal
      const allCustTaxAmt=custTaxes.reduce((s,t)=>s+t.amount,0);
      for(const tl of bizTaxes){
        const sub2=(tl.reducedBy||[]).reduce((s,c)=>{const f=custTaxes.find(t=>t.taxCode===c);return s+(f?f.amount:0);},0);
        const base=Math.max(0,(item.lineSubtotal+allCustTaxAmt)-sub2);
        const a=base*(tl.rate/100);tl.amount=a;bTax+=a;
        bd[tl.taxCode]={taxCode:tl.taxCode,taxName:tl.taxName,rate:tl.rate,businessTax:true,amount:(bd[tl.taxCode]?.amount||0)+a};
      }
      item.lineTotal=item.lineSubtotal+cTax;
    }
    item.taxAmount=cTax+bTax;item.customerTaxAmount=cTax;item.businessTaxAmount=bTax;
    sub+=item.lineSubtotal;totCustTax+=cTax;totBizTax+=bTax;
  }
  nInv.value.subtotal=n(sub);
  nInv.value.taxAmount=n(totCustTax);
  nInv.value.businessTaxAmount=n(totBizTax);
  nInv.value.taxBreakdown=Object.values(bd);
  nInv.value.total=nInv.value.taxInclusive
    ?nInv.value.items.reduce((s,i)=>s+(i.lineTotal||0),0)-(nInv.value.discount||0)
    :(sub+totCustTax)-(nInv.value.discount||0);
  nInv.value.balance=nInv.value.total-(nInv.value.paid||0);
}catch(e){console.error('calcInv error:',e);}}
function openNewInv(){nInv.value=fInv();invNoPreview.value='';iSrch.value='';iSrchRes.value=[];mErr.value='';loadCusts();loadTxRates();loadInvTypes();loadCas();loadBaccs();mInv.value=true;}
async function saveInv(){if(!nInv.value.items.length){mErr.value='Add at least one item';return;}saving.value=true;mErr.value='';try{await api('POST','/invoices',nInv.value);mInv.value=false;loadInvs();}catch(e){mErr.value=e.message;}saving.value=false;}
async function delInv(id){if(!confirm('Delete invoice?'))return;try{await api('DELETE','/invoices/'+id);loadInvs();}catch(e){alert(e.message);}}
async function srchProdsPO(){if(!poSrch.value.trim()){poSrchRes.value=[];return;}try{poSrchRes.value=(await api('GET','/products?search='+poSrch.value)).slice(0,8);}catch(e){}}
function addProdToPO(p){const isImp=nPO.value.purchaseType==='import';nPO.value.items.push({product:p._id,productName:p.name,sku:p.sku||'',qty:1,unit:p.unit||'pcs',unitCostForeign:isImp?0:p.costPrice,unitCost:p.costPrice,taxLines:[],taxAmount:0,lineSubtotal:0,lineTotal:0,landingCostShare:0,finalUnitCost:0});poSrch.value='';poSrchRes.value=[];calcPO();}
function addTaxToLC(lc,code){
  if(!code)return;
  if(!lc.taxLines)lc.taxLines=[];
  if(lc.taxLines.some(tl=>tl.taxCode===code))return;
  const tr=txRates.value.find(t=>t.code===code);
  if(!tr)return;
  lc.taxLines.push({taxCode:tr.code,taxName:tr.name,rate:tr.rate,creditable:tr.creditable||false,amount:0});
  calcPO();
}
function addTaxToPOLine(item,code){if(!code||item.taxLines.some(tl=>tl.taxCode===code))return;const tr=txRates.value.find(t=>t.code===code);if(!tr)return;item.taxLines.push({taxCode:tr.code,taxName:tr.name,rate:tr.rate,amount:0});calcPO();}
function calcPO(){
  if(!nPO.value||!nPO.value.items)return;const isImp=nPO.value.purchaseType==='import';const er=isImp?(nPO.value.exchangeRate||1):1;let subF=0,subL=0,totTax=0,lcTot=0;for(const item of nPO.value.items){if(isImp)item.unitCost=(item.unitCostForeign||0)*er;item.lineSubtotal=n(item.qty)*n(item.unitCost);subF+=(item.qty||0)*(item.unitCostForeign||0);let it=0;if(!nPO.value.taxInclusive&&item.taxLines?.length){item.taxLines=item.taxLines.map(tl=>{const a=n(item.lineSubtotal)*(n(tl.rate)/100);it+=a;return{...tl,amount:a};});}item.taxAmount=it;item.lineTotal=item.lineSubtotal+it;totTax+=it;subL+=item.lineSubtotal;}for(const lc of nPO.value.landingCosts){
    if(lc.currency&&lc.currency!=='LKR'&&lc.amountForeign)lc.amount=lc.amountForeign*er;
    let lcTax=0;
    for(const tl of(lc.taxLines||[])){tl.amount=(lc.amount||0)*(tl.rate/100);lcTax+=tl.amount;}
    lc.taxAmount=lcTax;lc.totalAmount=(lc.amount||0)+lcTax;
    lcTot+=(lc.amount||0)+lcTax;
  }const totV=nPO.value.items.reduce((s,i)=>s+(i.lineTotal||0),0);for(const item of nPO.value.items){const sh=totV?(item.lineTotal/totV)*lcTot:(nPO.value.items.length?lcTot/nPO.value.items.length:0);item.landingCostShare=sh;item.finalUnitCost=(item.unitCost||0)+(item.qty?sh/item.qty:0);}nPO.value.subtotalForeign=subF;nPO.value.subtotal=subL;nPO.value.taxAmount=totTax;nPO.value.landingCostTotal=lcTot;nPO.value.total=subL+totTax+lcTot;nPO.value.balance=nPO.value.total-(nPO.value.paid||0);}
function openNewPO(type){nPO.value=fPO(type);poSrch.value='';poSrchRes.value=[];mErr.value='';loadSupps();loadTxRates();mPO.value=true;}
async function savePO(){if(!nPO.value.items.length){mErr.value='Add at least one item';return;}saving.value=true;mErr.value='';try{await api('POST','/purchases',nPO.value);mPO.value=false;loadPOs();}catch(e){mErr.value=e.message;}saving.value=false;}
function openCust(c){eCust.value=c?{...c}:{name:'',phone:'',email:'',tin:'',address:''};mCust.value=true;}
async function saveCust(){saving.value=true;try{if(eCust.value._id)await api('PUT','/customers/'+eCust.value._id,eCust.value);else await api('POST','/customers',eCust.value);mCust.value=false;loadCusts();}catch(e){alert(e.message);}saving.value=false;}
function openSupp(s){eSupp.value=s?{...s}:{name:'',phone:'',email:'',address:''};mSupp.value=true;}
async function saveSupp(){saving.value=true;try{if(eSupp.value._id)await api('PUT','/suppliers/'+eSupp.value._id,eSupp.value);else await api('POST','/suppliers',eSupp.value);mSupp.value=false;loadSupps();}catch(e){alert(e.message);}saving.value=false;}
async function viewSuppHist(s){try{suppHist.value=await api('GET','/suppliers/'+s._id);mSuppH.value=true;}catch(e){alert(e.message);}}
function openCA(a){eCA.value=a?{...a}:{name:'',description:'',openingBalance:0};mCA.value=true;}
async function saveCA(){if(!eCA.value.name){alert('Name required');return;}saving.value=true;try{if(eCA.value._id)await api('PUT','/cash-accounts/'+eCA.value._id,eCA.value);else await api('POST','/cash-accounts',eCA.value);mCA.value=false;loadCas();}catch(e){alert(e.message);}saving.value=false;}
function openXfer(){eXfer.value={fromType:'cash',fromId:'',toType:'cash',toId:'',amount:0,date:today,description:'',reference:''};mErr.value='';loadCas();loadBaccs();mXfer.value=true;}
async function saveXfer(){if(!eXfer.value.fromId||!eXfer.value.toId){mErr.value='Select both accounts';return;}if(!eXfer.value.amount){mErr.value='Amount required';return;}saving.value=true;mErr.value='';try{await api('POST','/cash-accounts/transfer',eXfer.value);mXfer.value=false;loadCas();loadXfers();loadBaccs();}catch(e){mErr.value=e.message;}saving.value=false;}
function openExp(){eExp.value={date:today,category:'',description:'',amount:0,paymentMethod:'cash',cashAccount:'',bankAccount:'',chequeNo:'',vendor:'',reference:'',notes:''};mErr.value='';loadCas();loadBaccs();loadExpCats();mExp.value=true;}
async function saveExp(){
  if(!eExp.value.ledgerAccount&&!eExp.value.ledgerAccountName){mErr.value='Please select an expense account';return;}
  if(!eExp.value.description){mErr.value='Description required';return;}
  if(!eExp.value.amount||eExp.value.amount<=0){mErr.value='Amount must be greater than 0';return;}
  saving.value=true;mErr.value='';
  try{
    const d={...eExp.value};
    // Resolve ledger account name from selected ID
    if(d.ledgerAccount&&!d.ledgerAccountName){
      const acc=ledgerAccs.value.find(a=>a._id===d.ledgerAccount);
      if(acc)d.ledgerAccountName=acc.name;
    }
    if(!d.ledgerAccountName&&d.category)d.ledgerAccountName=d.category;
    if(!d.ledgerAccountName)d.ledgerAccountName='General Expenses';
    if(!d.cashAccount)delete d.cashAccount;
    if(!d.bankAccount)delete d.bankAccount;
    if(!d.ledgerAccount)delete d.ledgerAccount;
    await api('POST','/expenses',d);
    mExp.value=false;loadExps();loadCas();loadBaccs();
  }catch(e){mErr.value=e.message;}
  saving.value=false;
}
async function delExp(id){if(!confirm('Delete expense?'))return;try{await api('DELETE','/expenses/'+id);loadExps();loadCas();loadBaccs();}catch(e){alert(e.message);}}
function openPay(doc,type){payDoc.value=doc;payAmt.value=doc.balance;payMode.value='cash';payCashAcc.value='';payBankAcc.value='';payChqNo.value='';payDate.value=today;loadCas();loadBaccs();mPay.value=true;}
async function savePay(){saving.value=true;try{const ep=payDoc.value.invoiceNo?'/invoices/'+payDoc.value._id+'/payment':'/purchases/'+payDoc.value._id+'/payment';await api('PATCH',ep,{amount:payAmt.value,paymentMode:payMode.value,cashAccount:payCashAcc.value||undefined,bankAccount:payBankAcc.value||undefined,chequeNo:payChqNo.value||undefined,date:payDate.value});mPay.value=false;if(payDoc.value.invoiceNo)loadInvs();else loadPOs();}catch(e){alert(e.message);}saving.value=false;}
function openBAcc(a){eBAcc.value=a?{...a}:{name:'',bank:'',branch:'',accountNumber:'',type:'current',openingBalance:0};mErr.value='';mBAcc.value=true;}
async function saveBAcc(){if(!eBAcc.value.name){mErr.value='Name required';return;}saving.value=true;mErr.value='';try{if(eBAcc.value._id)await api('PUT','/banking/accounts/'+eBAcc.value._id,eBAcc.value);else await api('POST','/banking/accounts',eBAcc.value);mBAcc.value=false;loadBaccs();}catch(e){mErr.value=e.message;}saving.value=false;}
function openBTx(){eBTx.value={type:'deposit',account:'',toAccount:'',amount:0,date:today,description:'',chequeNo:'',reference:'',cleared:true};mErr.value='';mBTx.value=true;}
async function saveBTx(){if(!eBTx.value.account||!eBTx.value.amount){mErr.value='Account and amount required';return;}saving.value=true;mErr.value='';try{await api('POST','/banking/transactions',eBTx.value);mBTx.value=false;loadBaccs();loadBTxs();}catch(e){mErr.value=e.message;}saving.value=false;}
async function delBTx(id){if(!confirm('Delete? Balance will be reversed.'))return;try{await api('DELETE','/banking/transactions/'+id);loadBaccs();loadBTxs();}catch(e){alert(e.message);}}
async function viewStmt(a){stmtAcc.value=a;stmtRows.value=[];mStmt.value=true;await loadStmt();}
function openChq(c){eChq.value=c?{...c,date:c.date?new Date(c.date).toISOString().slice(0,10):today,dueDate:c.dueDate?new Date(c.dueDate).toISOString().slice(0,10):''}:{chequeNo:'',direction:'received',amount:0,party:'',bank:'',branch:'',date:today,dueDate:'',account:'',reference:'',status:'pending'};mErr.value='';mChq.value=true;}
async function saveChq(){if(!eChq.value.chequeNo||!eChq.value.dueDate){mErr.value='Cheque number and due date required';return;}saving.value=true;mErr.value='';try{if(eChq.value._id)await api('PUT','/cheques/'+eChq.value._id,eChq.value);else await api('POST','/cheques',eChq.value);mChq.value=false;loadChqs();}catch(e){mErr.value=e.message;}saving.value=false;}
function qChqSts(chq,sts,ev){if(!sts)return;ev.target.value='';if(sts==='deposited'||sts==='cleared'){chqStsData.value={cheque:chq,status:sts,accountId:chq.account||'',depositedDate:today,clearedDate:today};mChqSts.value=true;}else{api('PATCH','/cheques/'+chq._id+'/status',{status:sts}).then(()=>loadChqs()).catch(e=>alert(e.message));}}
async function saveChqSts(){saving.value=true;const{cheque,status,accountId,depositedDate,clearedDate}=chqStsData.value;try{await api('PATCH','/cheques/'+cheque._id+'/status',{status,accountId,depositedDate,clearedDate});mChqSts.value=false;loadChqs();loadBaccs();}catch(e){alert(e.message);}saving.value=false;}
async function delChq(id){if(!confirm('Delete cheque?'))return;try{await api('DELETE','/cheques/'+id);loadChqs();}catch(e){alert(e.message);}}
function openTxRate(t){eTxRate.value=t?{...t,reducedBy:[...(t.reducedBy||[])],businessTax:t.businessTax||false}:{code:'',name:'',rate:0,type:'both',appliesTo:'all',creditable:false,reducedBy:[],businessTax:false,description:''};mErr.value='';loadAllTxRates();mTxRate.value=true;}
async function saveTxRate(){if(!eTxRate.value.code||!eTxRate.value.name){mErr.value='Code and name required';return;}saving.value=true;mErr.value='';try{if(eTxRate.value._id)await api('PUT','/tax/'+eTxRate.value._id,eTxRate.value);else{eTxRate.value.code=eTxRate.value.code.toUpperCase().trim();await api('POST','/tax',eTxRate.value);}mTxRate.value=false;loadAllTxRates();loadTxRates();}catch(e){mErr.value=e.message;}saving.value=false;}
async function disableTxRate(id){if(!confirm('Disable this tax rate?'))return;try{await api('DELETE','/tax/'+id);loadAllTxRates();loadTxRates();}catch(e){alert(e.message);}}
function openInvType(t){eInvType.value=t?{...t}:{name:'',prefix:'',resetCycle:'daily',padLength:4,notes:''};mErr.value='';mInvType.value=true;}
async function saveInvType(){if(!eInvType.value.name||!eInvType.value.prefix){mErr.value='Name and prefix required';return;}saving.value=true;mErr.value='';try{if(eInvType.value._id)await api('PUT','/invoice-types/'+eInvType.value._id,eInvType.value);else await api('POST','/invoice-types',eInvType.value);mInvType.value=false;loadInvTypes();}catch(e){mErr.value=e.message;}saving.value=false;}
async function delInvType(id){if(!confirm('Delete?'))return;try{await api('DELETE','/invoice-types/'+id);loadInvTypes();}catch(e){alert(e.message);}}
function openLoc(l){eLoc.value=l?{...l}:{name:'',code:'',description:''};mLoc.value=true;}
async function saveLoc(){if(!eLoc.value.name){alert('Name required');return;}saving.value=true;try{if(eLoc.value._id)await api('PUT','/locations/'+eLoc.value._id,eLoc.value);else await api('POST','/locations',eLoc.value);mLoc.value=false;loadLocs();}catch(e){alert(e.message);}saving.value=false;}
function openUser(u){
  if(u){
    eUser.value={...u,newPwd:'',permissions:{...(ROLE_DEFAULTS[u.role]||ROLE_DEFAULTS.cashier),...(u.permissions||{})}};
  }else{
    eUser.value={name:'',username:'',role:'cashier',newPwd:'',permissions:{...ROLE_DEFAULTS.cashier}};
  }
  mErr.value='';mUser.value=true;
}
async function saveUser(){if(!eUser.value.name){mErr.value='Name required';return;}if(!eUser.value._id&&!eUser.value.newPwd){mErr.value='Password required for new users';return;}saving.value=true;mErr.value='';try{if(eUser.value._id)await api('PUT','/auth/users/'+eUser.value._id,eUser.value);else await api('POST','/auth/users',{...eUser.value,password:eUser.value.newPwd});mUser.value=false;loadUsers();}catch(e){mErr.value=e.message;}saving.value=false;}
async function disableUser(id){if(!confirm('Disable this user?'))return;try{await api('PUT','/auth/users/'+id,{active:false});loadUsers();}catch(e){alert(e.message);}}

// ── CASH ACCOUNT LEDGER ────────────────────────────────────────────────────
async function viewCashLedger(a){cashLedgerAcc.value=a;cashLedFr.value='';cashLedTo.value='';await loadCashLedger();}
async function loadCashLedger(){
  if(!cashLedgerAcc.value)return;
  try{
    let q='';
    if(cashLedFr.value)q+='from='+cashLedFr.value;
    if(cashLedTo.value)q+=(q?'&':'')+'to='+cashLedTo.value;
    const r=await api('GET','/cash-accounts/'+(cashLedgerAcc.value?._id||cashLedgerAcc.value)+'/ledger'+(q?'?'+q:''));
    cashLedRows.value=r.rows||[];
  }catch(e){alert(e.message);}
}

// ── INVOICE TYPE TAX CONFIG ────────────────────────────────────────────────
function addTaxToInvType(code){
  if(!code)return;
  const t=txRates.value.find(t=>t.code===code);
  if(!t)return;
  if(!eInvType.value.taxConfig)eInvType.value.taxConfig=[];
  eInvType.value.taxConfig.push({taxCode:t.code,taxName:t.name,rate:t.rate,creditable:t.creditable||false,mode:'always'});
}

// When invoice type is selected, load its tax config onto the invoice
function applyInvTypeTaxConfig(typeId){
  const t=invTypes.value.find(t=>t._id===typeId);
  if(!t||!(t.taxConfig&&t.taxConfig.length)){
    nInv.value.invTypeTaxConfig=[];
    nInv.value.toggledTaxes={};
    if(nInv.value.items.length)applyInvTypeTaxesToItems();
    return;
  }
  nInv.value.invTypeTaxConfig=t.taxConfig;
  // Default: toggle-mode taxes start OFF
  const toggled={};
  for(const tc of t.taxConfig){
    if(tc.mode==='toggle')toggled[tc.taxCode]=false;
  }
  nInv.value.toggledTaxes=toggled;
  // Apply to any existing items (e.g. if user added items first then changed type)
  applyInvTypeTaxesToItems();
}

function toggleInvTypeTax(code){
  nInv.value.toggledTaxes[code]=!nInv.value.toggledTaxes[code];
  applyInvTypeTaxesToItems();
  calcInv();
}

function applyInvTypeTaxesToItems(){
  // Build active tax list from invoice type config
  const activeTaxes=[];
  for(const tc of nInv.value.invTypeTaxConfig||[]){
    if(tc.mode==='always'||nInv.value.toggledTaxes[tc.taxCode]){
      const fr=txRates.value.find(t=>t.code===tc.taxCode);activeTaxes.push({taxCode:tc.taxCode,taxName:tc.taxName,rate:tc.rate,reducedBy:fr?.reducedBy||[],amount:0});
    }
  }
  // Update each item's tax lines with invoice-type taxes (preserve manually added taxes too)
  for(const item of nInv.value.items){
    // Remove old inv-type taxes, keep manually-added ones
    const manual=item.taxLines.filter(tl=>!(nInv.value.invTypeTaxConfig||[]).some(tc=>tc.taxCode===tl.taxCode));
    item.taxLines=[...manual,...activeTaxes.map(t=>({...t}))];
  }
  calcInv();
}


// ── INVOICE DETAIL ─────────────────────────────────────────────────────────
function openInvDetail(inv){invDet.value={...inv};mInvDetail.value=true;}

// ── PO DETAIL: Payment Stages + Goods Received ────────────────────────────
async function finalizePO(){
  if(!confirm('Mark this purchase as FINAL? It cannot be edited after this.'))return;
  try{
    const updated=await api('PATCH','/purchases/'+poDet.value._id+'/finalize');
    poDet.value={...updated};loadPOs();
  }catch(e){alert(e.message);}
}
async function savePONotes(){
  if(poDet.value.isFinalized)return;
  try{await api('PUT','/purchases/'+poDet.value._id,{notes:poDet.value.notes});}catch(e){}
}
// ── PO DETAIL EDITING ───────────────────────────────────────────────────────
async function poDetSrchProds(){
  if(!poDetSrch.value.trim()){poDetSrchRes.value=[];return;}
  try{poDetSrchRes.value=(await api('GET','/products?search='+poDetSrch.value)).slice(0,8);}catch(e){}
}
function poDetAddItem(p){
  const isImp=poDet.value.purchaseType==='import';
  poDet.value.items.push({product:p._id,productName:p.name,sku:p.sku||'',qty:1,unit:p.unit||'pcs',
    unitCostForeign:isImp?0:p.costPrice,unitCost:p.costPrice,
    taxLines:[],taxAmount:0,lineSubtotal:0,lineTotal:0,landingCostShare:0,finalUnitCost:0});
  poDetSrch.value='';poDetSrchRes.value=[];calcPoDet();
}
function poDetAddManualItem(){
  poDet.value.items.push({product:null,productName:'',sku:'',qty:1,unit:'pcs',
    unitCostForeign:0,unitCost:0,taxLines:[],taxAmount:0,lineSubtotal:0,lineTotal:0});
  calcPoDet();
}
function poDetRemoveItem(i){poDet.value.items.splice(i,1);calcPoDet();}
function poDetAddLC(){
  poDet.value.landingCosts.push({description:'',currency:'LKR',amountForeign:0,amount:0,taxLines:[],taxAmount:0,totalAmount:0,isImportTax:false});
  calcPoDet();
}
function poDetRemoveLC(i){poDet.value.landingCosts.splice(i,1);calcPoDet();}
function calcPoDet(){try{
  const isImp=poDet.value.purchaseType==='import';
  const er=isImp?(poDet.value.exchangeRate||1):1;
  let subF=0,subL=0,totTax=0,lcNet=0,lcTax=0;
  for(const item of poDet.value.items){
    if(isImp)item.unitCost=(item.unitCostForeign||0)*er;
    item.lineSubtotal=n(item.qty)*n(item.unitCost);
    subF+=(item.qty||0)*(item.unitCostForeign||0);
    let it=0;
    if(item.taxLines?.length){item.taxLines=item.taxLines.map(tl=>{const a=n(item.lineSubtotal)*(n(tl.rate)/100);it+=a;return{...tl,amount:a};});}
    item.taxAmount=it;item.lineTotal=item.lineSubtotal+it;totTax+=it;subL+=item.lineSubtotal;
  }
  for(const lc of poDet.value.landingCosts){
    if(lc.currency&&lc.currency!=='LKR'&&lc.amountForeign)lc.amount=lc.amountForeign*er;
    let lt=0;
    for(const tl of(lc.taxLines||[])){tl.amount=(lc.amount||0)*(tl.rate/100);lt+=tl.amount;}
    lc.taxAmount=lt;lc.totalAmount=(lc.amount||0)+lt;
    lcNet+=(lc.amount||0);lcTax+=lt;
  }
  poDet.value.subtotal=subL;poDet.value.taxAmount=totTax;
  poDet.value.landingCostTotal=lcNet;poDet.value.landingTaxTotal=lcTax;
  poDet.value.total=subL+totTax+lcNet+lcTax;
  poDet.value.balance=poDet.value.total-(poDet.value.paid||0);
}catch(e){console.error('calcPoDet error:',e);}}
async function savePoDetItems(){
  if(poDet.value.isFinalized)return;
  try{
    const updated=await api('PUT','/purchases/'+poDet.value._id,{
      items:poDet.value.items,
      landingCosts:poDet.value.landingCosts,
      subtotal:poDet.value.subtotal,
      taxAmount:poDet.value.taxAmount,
      landingCostTotal:poDet.value.landingCostTotal,
      landingTaxTotal:poDet.value.landingTaxTotal||0,
      total:poDet.value.total,
    });
    poDet.value={...updated};
    loadPOs();
    alert('Items saved ✓');
  }catch(e){alert(e.message);}
}
const calcPodet=calcPoDet;

function poDetAddTaxToItem(item,code){
  if(!code||item.taxLines.some(tl=>tl.taxCode===code))return;
  const tr=txRates.value.find(t=>t.code===code);
  if(!tr)return;
  item.taxLines.push({taxCode:tr.code,taxName:tr.name,rate:tr.rate,amount:0});
  calcPodet();
}
function openPODetail(po){
  poDet.value={...po};
  const today2=new Date().toISOString().slice(0,10);
  newStage.value={amount:0,date:today2,paymentMode:'bank',description:'',reference:'',cashAccount:'',bankAccount:''};
  loadCas();loadBaccs();
  mPODetail.value=true;
}
async function savePayStage(){
  if(!newStage.value.amount||newStage.value.amount<=0){alert('Enter amount');return;}
  saving.value=true;
  try{
    const d={...newStage.value};
    if(!d.cashAccount)delete d.cashAccount;
    if(!d.bankAccount)delete d.bankAccount;
    const updated=await api('POST','/purchases/'+poDet.value._id+'/payment-stage',d);
    poDet.value={...updated};
    // Reset form but keep settings
    newStage.value={...newStage.value,amount:0,description:'',reference:''};
    loadPOs();
  }catch(e){alert(e.message);}
  saving.value=false;
}
async function delPayStage(stageId){
  if(!confirm('Remove this payment?'))return;
  try{
    const updated=await api('DELETE','/purchases/'+poDet.value._id+'/payment-stage/'+stageId);
    poDet.value={...updated};
    loadPOs();
  }catch(e){alert(e.message);}
}
async function toggleGoodsReceived(){
  const newVal=!poDet.value.goodsReceived;
  const label=newVal?'Mark goods as RECEIVED?':'Mark goods as NOT yet received?';
  if(!confirm(label))return;
  try{
    const updated=await api('PATCH','/purchases/'+poDet.value._id+'/goods-received',{received:newVal,date:new Date().toISOString().slice(0,10)});
    poDet.value={...updated};
    loadPOs();
  }catch(e){alert(e.message);}
}


// ── INVOICE RETURNS ─────────────────────────────────────────────────────────
function openReturn(inv){
  retInv.value={...inv};
  retItems.value=(inv.items||[]).map(item=>({
    ...item,
    origQty: item.qty,
    returnQty: item.qty, // default to full return
  }));
  retReason.value='';
  retDate.value=new Date().toISOString().slice(0,10);
  retRestock.value=true;
  mErr.value='';
  calcReturnTotal();
  mReturn.value=true;
}
function calcReturnTotal(){
  retTotal.value=retItems.value.reduce((s,item)=>{
    if(!item.returnQty||item.returnQty<=0)return s;
    const ratio=item.returnQty/item.origQty;
    return s+(item.lineTotal||0)*ratio;
  },0);
}
async function saveReturn(){
  const itemsToReturn=retItems.value.filter(i=>i.returnQty>0).map(i=>({
    productName:i.productName, itemId:i._id, qty:i.returnQty
  }));
  if(!itemsToReturn.length){mErr.value='Select at least one item to return';return;}
  saving.value=true;mErr.value='';
  try{
    await api('POST','/invoices/'+retInv.value._id+'/return',{
      items:itemsToReturn, reason:retReason.value, date:retDate.value, restockItems:retRestock.value
    });
    mReturn.value=false;
    loadInvs();
    alert('Return processed successfully. Credit note created.');
  }catch(e){mErr.value=e.message;}
  saving.value=false;
}

onMounted(()=>{if(tok.value){loadDash();loadTxRates();loadCas();loadInvTypes();loadLocs();loadSavedCats();loadCats();}});
return{tok,me,lf,lerr,lding,spwd,pw,pwErr,pwOk,can,login,logout,changePw,
pg,saving,mErr,dash,prods,invs,pos,custs,supps,cats,txRates,allTxRates,taxRpt,users,invTypes,locs,
cas,xfers,exps,exSumm,expCats,baccs,btxs,btab,btf,chqs,chqf,
ledDays,trial,trialGrp,ledV,ledFr,ledTo,ledAccList,ledAcc,accLedRows,
txFr,txTo,txYear,txYears,curYear,curMonth,txMonthly,rpt,rptDate,rptTab,
psrch,ifilt,pofilt,exFrom,exTo,suppHist,stmtAcc,stmtFr,stmtTo,stmtRows,
payDoc,payAmt,payMode,payCashAcc,payBankAcc,payChqNo,payDate,
iSrch,iSrchRes,iSrchLoading,poSrch,poSrchRes,invNoPreview,nInv,nPO,
mProd,mStk,mCust,mSupp,mSuppH,mCA,mXfer,mExp,mPay,mTxRate,mInvType,mLoc,mUser,mBAcc,mBTx,mStmt,mChq,mChqSts,mInv,mPO,
eProd,eStk,eCust,eSupp,eCA,eXfer,eExp,eTxRate,eInvType,eLoc,eUser,eBAcc,eBTx,eChq,chqStsData,PERM_GROUPS,applyRoleDefaults,
tdate,todayStr,lowStock,pendChq,f,fd,fdL,bp,bs,chqSC,chqDue,
openProd,addProdLoc,saveProd,delProd,openStk,saveStkAdj,saveLocStk,
previewInvNo,onCustChange,srchProds,addFirstProd,addProdToInv,addTaxToLine,calcInv,openNewInv,saveInv,delInv,
srchProdsPO,addProdToPO,addTaxToPOLine,addTaxToLC,calcPO,openNewPO,savePO,
openCust,saveCust,openSupp,saveSupp,viewSuppHist,
openCA,saveCA,openXfer,saveXfer,openExp,saveExp,delExp,openPay,savePay,
openBAcc,saveBAcc,openBTx,saveBTx,delBTx,viewStmt,loadStmt,loadBTxs,mStockMovement,stockMovementData,viewStockMovement,mPODetail,poDet,newStage,openPODetail,savePayStage,delPayStage,toggleGoodsReceived,finalizePO,savePONotes,poFinFilt,poDetSrch,poDetSrchRes,poDetSrchProds,poDetAddItem,poDetAddManualItem,poDetRemoveItem,poDetAddLC,poDetRemoveLC,calcPodet:calcPoDet,savePoDetItems,poDetAddTaxToItem,mInvDetail,invDet,openInvDetail,mReturn,retInv,retItems,retTotal,retReason,retDate,retRestock,openReturn,calcReturnTotal,saveReturn,
openChq,saveChq,qChqSts,saveChqSts,delChq,
openTxRate,saveTxRate,disableTxRate,openInvType,saveInvType,delInvType,mTaxDetail,taxDetailData,openTaxDetail,
openLoc,saveLoc,openUser,saveUser,disableUser,viewCashLedger,loadCashLedger,cashLedgerAcc,cashLedRows,cashLedFr,cashLedTo,selectedCashRow,mEditCashEntry,eCashEntry,editCashEntry,saveCashEntry,delCashEntry,addTaxToInvType,applyInvTypeTaxConfig,toggleInvTypeTax,
loadLed,loadAccLed,loadTaxRpt,loadTaxMonthly,loadRpt,expandedRptRows,toggleRptRow,loadInvs,loadExps,mCat,eCat,savedCats,pCatFilter,saveCat,delCat,prodsByCategory,mQuickProd,openQuickProd,saveQuickProd,toggleLooseMode,
  isDark,toggleTheme,mCoSettings,coSettings,saveCoSettings,
  mPrintInv,printInv,printTpl,printColor,printShowTax,printShowNotes,invPreviewStyle,printInvoice,doPrint,
  ledgerAccs,mLedgerAcc,eLedgerAcc,mJournalEntry,eJournalEntry,openJournalEntry,saveJournalEntry,mQuickJournal,eQuickJournal,qjAccountGroups,openQuickJournal,onQJTypeChange,onQJDebitChange,onQJCreditChange,saveQuickJournal,mLedgerAccDetail,ledgerAccDetail,mEditLedgerEntry,eEditLedgerEntry,editLedgerEntry,saveLedgerEntry,delLedgerEntry,ledgerAccsByType,loadLedgerAccs,openLedgerAcc,saveLedgerAcc,delLedgerAcc,viewLedgerAcc,trialBalance,loadTrialBalance,expAccFilter,onLedgerAccChange};
}}).mount('#app');
});


// Global error handler for unhandled promise rejections
window.addEventListener('unhandledrejection', e => {
  console.error('[StoreOS] Unhandled error:', e.reason);
});