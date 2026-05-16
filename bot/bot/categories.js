const CATEGORIES = [
  'Bills & Utilities:Electricity',
  'Bills & Utilities:Mobile Phone',
  'Bills & Utilities:Internet',
  'Bills & Utilities:Water',
  'Bills & Utilities:Pay TV',
  'Bills & Utilities:Gas',
  'Food & Dining:Groceries',
  'Food & Dining:Restaurants',
  'Food & Dining:Takeaway',
  'Food & Dining:Coffee',
  'Food & Dining:Alcohol',
  'Transport:Fuel',
  'Transport:Parking',
  'Transport:Matatu / Bus',
  'Transport:Ride Hail',
  'Transport:Air Travel',
  'Transport:Vehicle Maintenance',
  'Health:Pharmacy',
  'Health:Doctor / Hospital',
  'Health:Gym / Fitness',
  'Education:School Fees',
  'Education:Books & Materials',
  'Education:Online Courses',
  'Shopping:Clothing',
  'Shopping:Electronics',
  'Shopping:Home & Garden',
  'Shopping:Personal Care',
  'Entertainment:Streaming',
  'Entertainment:Events',
  'Entertainment:Games',
  'Subscriptions:Software',
  'Subscriptions:News / Media',
  'Subscriptions:Cloud Storage',
  'Home:Rent',
  'Home:Repairs',
  'Home:Household Items',
  'Home:Cleaning',
  'Family:Claire Gift',
  'Family:Children',
  'Family:Domestic Help',
  'Family:School Items',
  'Farm:Feed',
  'Farm:Veterinary',
  'Farm:Labour',
  'Farm:Equipment',
  'Farm:Utilities',
  'Financial:Investment',
  'Financial:Savings Deposit',
  'Financial:Insurance',
  'Loan Payment:Principal',
  'Loan Payment:Interest',
  'Loan Payment:Fuliza',
  'Loan Payment:M-Shwari',
  'Loan Payment:Tala',
  'Loan Payment:Timiza',
  'Loan Payment:SACCO',
  'Personal Loan:Lending',
  'Personal Loan:Repayment',
  'Income:Salary',
  'Income:Freelance',
  'Income:Dividends',
  'Income:Rental',
  'Income:Other',
  'Transfers:M-PESA Internal',
  'Transfers:Bank to M-PESA',
  'Transfers:M-PESA to Bank',
  'Transfers:Loop',
  'Transfers:Savings',
  'Fees & Charges:M-PESA Fee',
  'Fees & Charges:Bank Fee',
  'Fees & Charges:Loop Fee',
  'Fees & Charges:Excise Duty',
  'Tax:VAT',
  'Tax:Income Tax',
  'Gifts & Donations:Family',
  'Gifts & Donations:Church / Tithe',
  'Gifts & Donations:Charity',
  'Cash & ATM',
  'Interest Expense',
  'Uncategorized'
];

// Group categories by parent for display
const CATEGORY_GROUPS = {};
CATEGORIES.forEach(cat => {
  const parts = cat.split(':');
  const group = parts.length > 1 ? parts[0] : 'Other';
  const label = parts.length > 1 ? parts[1].trim() : cat;
  if (!CATEGORY_GROUPS[group]) CATEGORY_GROUPS[group] = [];
  CATEGORY_GROUPS[group].push({ full: cat, label });
});

// Regex-based category suggestion
const CATEGORY_RULES = [
  { p: /safaricom|airtime|data bundle/i, c: 'Bills & Utilities:Mobile Phone' },
  { p: /kplc|kenya power|tokens/i, c: 'Bills & Utilities:Electricity' },
  { p: /dstv|multichoice|zuku/i, c: 'Bills & Utilities:Pay TV' },
  { p: /netflix|spotify|apple\.com\/bill|amazon kids/i, c: 'Entertainment:Streaming' },
  { p: /microsoft|office 365/i, c: 'Subscriptions:Software' },
  { p: /total|shell|kenol|rubis|atlas petroleum/i, c: 'Transport:Fuel' },
  { p: /uber|bolt|little cab|indriver/i, c: 'Transport:Ride Hail' },
  { p: /naivas|carrefour|quickmart|cleanshelf/i, c: 'Food & Dining:Groceries' },
  { p: /pharmacy|chemist|goodlife/i, c: 'Health:Pharmacy' },
  { p: /school fees|tuition/i, c: 'Education:School Fees' },
  { p: /ziidi|cytonn/i, c: 'Financial:Investment' },
  { p: /fuliza/i, c: 'Loan Payment:Fuliza' },
  { p: /m-shwari|mshwari/i, c: 'Loan Payment:M-Shwari' },
  { p: /\btala\b/i, c: 'Loan Payment:Tala' },
  { p: /timiza/i, c: 'Loan Payment:Timiza' },
  { p: /sacco|kimisitu/i, c: 'Loan Payment:SACCO' },
  { p: /excise duty/i, c: 'Fees & Charges:Excise Duty' },
  { p: /transaction cost|m-pesa.*fee/i, c: 'Fees & Charges:M-PESA Fee' },
  { p: /co-op.*bank|cooperative bank/i, c: 'Income:Other' },
  { p: /salary|payroll/i, c: 'Income:Salary' },
  { p: /claire|adaka/i, c: 'Family:Claire Gift' },
];

function suggestCategory(text) {
  for (const r of CATEGORY_RULES) {
    if (r.p.test(text)) return r.c;
  }
  return 'Uncategorized';
}

module.exports = { CATEGORIES, CATEGORY_GROUPS, suggestCategory };
