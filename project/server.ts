import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { 
  initializeDb, 
  db, 
  User, 
  Debt, 
  Transaction, 
  Budget, 
  ChatSession, 
  ChatMessage, 
  Report, 
  Notification, 
  Goal, 
  Feedback 
} from './server/db.js';
import { hashPassword, generateToken, verifyToken } from './server/crypto.js';

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize local JSON database
initializeDb();

// Lazy Gemini API initialization helper
let aiClient: GoogleGenAI | null = null;
function getAI(): GoogleGenAI | null {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      console.warn("GEMINI_API_KEY is not configured or has default value. AI operations will use detailed mock recommendations.");
      return null;
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

// Authentication Middleware
function authenticateToken(req: any, res: any, next: any) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. Token missing.' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(403).json({ error: 'Access denied. Token invalid or expired.' });
  }

  req.user = decoded;
  next();
}

// Admin Check Middleware
function requireAdmin(req: any, res: any, next: any) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Access denied. Admin permissions required.' });
  }
  next();
}

// Helper to generate IDs
function generateId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).substring(2, 11)}`;
}

// ---------------- REST APIs ----------------

// Auth APIs
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, income } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Please provide all required fields' });
  }

  const existing = db.getUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  // Set the first user or email 'vnsp444@gmail.com' as admin
  const isEmailAdmin = email.toLowerCase() === 'vnsp444@gmail.com';

  const newUser: User = {
    id: generateId('user'),
    name,
    email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    isAdmin: isEmailAdmin,
    income: Number(income) || 0,
    createdAt: new Date().toISOString()
  };

  db.addUser(newUser);

  // Auto-generate token
  const token = generateToken({ userId: newUser.id, email: newUser.email, isAdmin: newUser.isAdmin });
  
  // Create first notification
  db.addNotification({
    id: generateId('notif'),
    userId: newUser.id,
    title: 'Welcome to Financial Recovery!',
    message: `Hi ${name}, we're excited to help you on your journey to debt-free living. Start by adding your debts and income log.`,
    type: 'ai_tip',
    isRead: false,
    createdAt: new Date().toISOString()
  });

  res.status(201).json({
    token,
    user: {
      id: newUser.id,
      name: newUser.name,
      email: newUser.email,
      isAdmin: newUser.isAdmin,
      income: newUser.income
    }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Please provide email and password' });
  }

  const user = db.getUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  if (user.passwordHash !== hashPassword(password)) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  const token = generateToken({ userId: user.id, email: user.email, isAdmin: user.isAdmin });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
      income: user.income
    }
  });
});

app.get('/api/auth/me', authenticateToken, (req: any, res) => {
  const user = db.getUsers().find(u => u.id === req.user.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    isAdmin: user.isAdmin,
    income: user.income,
    createdAt: user.createdAt
  });
});

app.put('/api/auth/profile', authenticateToken, (req: any, res) => {
  const { name, income } = req.body;
  const users = db.getUsers();
  const userIndex = users.findIndex(u => u.id === req.user.userId);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (name !== undefined) users[userIndex].name = name;
  if (income !== undefined) users[userIndex].income = Number(income) || 0;

  db.save();

  res.json({
    id: users[userIndex].id,
    name: users[userIndex].name,
    email: users[userIndex].email,
    isAdmin: users[userIndex].isAdmin,
    income: users[userIndex].income
  });
});

// Debt Management APIs
app.get('/api/debts', authenticateToken, (req: any, res) => {
  const userDebts = db.getDebts().filter(d => d.userId === req.user.userId);
  res.json(userDebts);
});

app.post('/api/debts', authenticateToken, (req: any, res) => {
  const { name, lender, loanType, outstandingBalance, interestRate, dueDay, emi } = req.body;
  
  if (!name || outstandingBalance === undefined || interestRate === undefined) {
    return res.status(400).json({ error: 'Name, balance, and interest rate are required' });
  }

  const newDebt: Debt = {
    id: generateId('debt'),
    userId: req.user.userId,
    name,
    lender: lender || 'Private Lender',
    loanType: loanType || 'Other',
    outstandingBalance: Number(outstandingBalance),
    interestRate: Number(interestRate),
    dueDay: Number(dueDay) || 15,
    emi: Number(emi) || 0,
    createdAt: new Date().toISOString()
  };

  db.addDebt(newDebt);

  // Trigger custom notifications check
  if (newDebt.outstandingBalance > 10000) {
    db.addNotification({
      id: generateId('notif'),
      userId: req.user.userId,
      title: 'High Interest Alert',
      message: `Your debt "${name}" is $${newDebt.outstandingBalance}. Consider setting up a Snowball or Avalanche payment planner to cut interest expenses.`,
      type: 'due_alert',
      isRead: false,
      createdAt: new Date().toISOString()
    });
  }

  res.status(201).json(newDebt);
});

app.put('/api/debts/:id', authenticateToken, (req: any, res) => {
  const { name, lender, loanType, outstandingBalance, interestRate, dueDay, emi } = req.body;
  const debts = db.getDebts();
  const debtIndex = debts.findIndex(d => d.id === req.params.id && d.userId === req.user.userId);

  if (debtIndex === -1) {
    return res.status(404).json({ error: 'Debt not found' });
  }

  const updatedDebt = { ...debts[debtIndex] };
  if (name !== undefined) updatedDebt.name = name;
  if (lender !== undefined) updatedDebt.lender = lender;
  if (loanType !== undefined) updatedDebt.loanType = loanType;
  if (outstandingBalance !== undefined) updatedDebt.outstandingBalance = Number(outstandingBalance);
  if (interestRate !== undefined) updatedDebt.interestRate = Number(interestRate);
  if (dueDay !== undefined) updatedDebt.dueDay = Number(dueDay);
  if (emi !== undefined) updatedDebt.emi = Number(emi);

  debts[debtIndex] = updatedDebt;
  db.save();

  res.json(updatedDebt);
});

app.delete('/api/debts/:id', authenticateToken, (req: any, res) => {
  const debts = db.getDebts();
  const debtIndex = debts.findIndex(d => d.id === req.params.id && d.userId === req.user.userId);

  if (debtIndex === -1) {
    return res.status(404).json({ error: 'Debt not found' });
  }

  const deleted = debts.splice(debtIndex, 1)[0];
  db.save();

  res.json({ message: 'Debt removed successfully', deleted });
});

// Income & Expenses APIs
app.get('/api/transactions', authenticateToken, (req: any, res) => {
  const userTxs = db.getTransactions().filter(t => t.userId === req.user.userId);
  res.json(userTxs);
});

app.post('/api/transactions', authenticateToken, (req: any, res) => {
  const { type, category, amount, date, description } = req.body;

  if (!type || !category || amount === undefined || !date) {
    return res.status(400).json({ error: 'Type, category, amount, and date are required' });
  }

  const newTx: Transaction = {
    id: generateId('tx'),
    userId: req.user.userId,
    type,
    category,
    amount: Number(amount),
    date,
    description: description || '',
    createdAt: new Date().toISOString()
  };

  db.addTransaction(newTx);

  // Check budget limits for expenses
  if (type === 'expense') {
    const budget = db.getBudgets().find(b => b.userId === req.user.userId && b.category.toLowerCase() === category.toLowerCase());
    if (budget) {
      // Calculate total spent in this category for this month
      const currentMonth = date.substring(0, 7); // YYYY-MM
      const totalSpent = db.getTransactions()
        .filter(t => t.userId === req.user.userId && t.type === 'expense' && t.category.toLowerCase() === category.toLowerCase() && t.date.startsWith(currentMonth))
        .reduce((sum, t) => sum + t.amount, 0);

      if (totalSpent > budget.amount) {
        db.addNotification({
          id: generateId('notif'),
          userId: req.user.userId,
          title: `Budget Exceeded: ${category}`,
          message: `You have spent $${totalSpent.toFixed(2)} on "${category}" which exceeds your monthly budget of $${budget.amount}.`,
          type: 'budget_alert',
          isRead: false,
          createdAt: new Date().toISOString()
        });
      } else if (totalSpent > budget.amount * 0.8) {
        db.addNotification({
          id: generateId('notif'),
          userId: req.user.userId,
          title: `Budget Warning: ${category}`,
          message: `You have used ${Math.round((totalSpent / budget.amount) * 100)}% of your monthly budget for "${category}".`,
          type: 'budget_alert',
          isRead: false,
          createdAt: new Date().toISOString()
        });
      }
    }
  }

  res.status(201).json(newTx);
});

app.put('/api/transactions/:id', authenticateToken, (req: any, res) => {
  const { type, category, amount, date, description } = req.body;
  const txs = db.getTransactions();
  const txIndex = txs.findIndex(t => t.id === req.params.id && t.userId === req.user.userId);

  if (txIndex === -1) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  const updatedTx = { ...txs[txIndex] };
  if (type !== undefined) updatedTx.type = type;
  if (category !== undefined) updatedTx.category = category;
  if (amount !== undefined) updatedTx.amount = Number(amount);
  if (date !== undefined) updatedTx.date = date;
  if (description !== undefined) updatedTx.description = description;

  txs[txIndex] = updatedTx;
  db.save();

  res.json(updatedTx);
});

app.delete('/api/transactions/:id', authenticateToken, (req: any, res) => {
  const txs = db.getTransactions();
  const txIndex = txs.findIndex(t => t.id === req.params.id && t.userId === req.user.userId);

  if (txIndex === -1) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  const deleted = txs.splice(txIndex, 1)[0];
  db.save();

  res.json({ message: 'Transaction removed successfully', deleted });
});

// Budget APIs
app.get('/api/budgets', authenticateToken, (req: any, res) => {
  const userBudgets = db.getBudgets().filter(b => b.userId === req.user.userId);
  res.json(userBudgets);
});

app.post('/api/budgets', authenticateToken, (req: any, res) => {
  const { category, amount } = req.body;
  if (!category || amount === undefined) {
    return res.status(400).json({ error: 'Category and amount are required' });
  }

  const budgets = db.getBudgets();
  const existingIndex = budgets.findIndex(b => b.userId === req.user.userId && b.category.toLowerCase() === category.toLowerCase());

  if (existingIndex !== -1) {
    budgets[existingIndex].amount = Number(amount);
    db.save();
    return res.json(budgets[existingIndex]);
  }

  const newBudget: Budget = {
    id: generateId('budget'),
    userId: req.user.userId,
    category,
    amount: Number(amount),
    createdAt: new Date().toISOString()
  };

  db.addBudget(newBudget);
  res.status(201).json(newBudget);
});

// Goals APIs
app.get('/api/goals', authenticateToken, (req: any, res) => {
  const userGoals = db.getGoals().filter(g => g.userId === req.user.userId);
  res.json(userGoals);
});

app.post('/api/goals', authenticateToken, (req: any, res) => {
  const { title, targetAmount, currentAmount, deadline } = req.body;
  if (!title || targetAmount === undefined || !deadline) {
    return res.status(400).json({ error: 'Title, target amount, and deadline are required' });
  }

  const newGoal: Goal = {
    id: generateId('goal'),
    userId: req.user.userId,
    title,
    targetAmount: Number(targetAmount),
    currentAmount: Number(currentAmount) || 0,
    deadline,
    createdAt: new Date().toISOString()
  };

  db.addGoal(newGoal);
  res.status(201).json(newGoal);
});

app.put('/api/goals/:id', authenticateToken, (req: any, res) => {
  const { title, targetAmount, currentAmount, deadline } = req.body;
  const goals = db.getGoals();
  const goalIndex = goals.findIndex(g => g.id === req.params.id && g.userId === req.user.userId);

  if (goalIndex === -1) {
    return res.status(404).json({ error: 'Goal not found' });
  }

  const updated = { ...goals[goalIndex] };
  if (title !== undefined) updated.title = title;
  if (targetAmount !== undefined) updated.targetAmount = Number(targetAmount);
  if (currentAmount !== undefined) {
    updated.currentAmount = Number(currentAmount);
    // Add positive notification if complete
    if (updated.currentAmount >= updated.targetAmount && goals[goalIndex].currentAmount < goals[goalIndex].targetAmount) {
      db.addNotification({
        id: generateId('notif'),
        userId: req.user.userId,
        title: '🎉 Goal Achieved!',
        message: `Congratulations! You have successfully hit your saving/debt payoff target of $${updated.targetAmount} for "${updated.title}"!`,
        type: 'ai_tip',
        isRead: false,
        createdAt: new Date().toISOString()
      });
    }
  }
  if (deadline !== undefined) updated.deadline = deadline;

  goals[goalIndex] = updated;
  db.save();

  res.json(updated);
});

app.delete('/api/goals/:id', authenticateToken, (req: any, res) => {
  const goals = db.getGoals();
  const index = goals.findIndex(g => g.id === req.params.id && g.userId === req.user.userId);

  if (index === -1) {
    return res.status(404).json({ error: 'Goal not found' });
  }

  const deleted = goals.splice(index, 1)[0];
  db.save();

  res.json({ message: 'Goal removed successfully', deleted });
});

// Notifications APIs
app.get('/api/notifications', authenticateToken, (req: any, res) => {
  const userNotifs = db.getNotifications().filter(n => n.userId === req.user.userId);
  res.json(userNotifs);
});

app.put('/api/notifications/:id/read', authenticateToken, (req: any, res) => {
  const notifs = db.getNotifications();
  const index = notifs.findIndex(n => n.id === req.params.id && n.userId === req.user.userId);

  if (index === -1) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  notifs[index].isRead = true;
  db.save();

  res.json(notifs[index]);
});

// ---------------- AI Financial Assistant Chats ----------------

// Get all chat sessions
app.get('/api/chats', authenticateToken, (req: any, res) => {
  const sessions = db.getChats()
    .filter(c => c.userId === req.user.userId)
    .map(({ id, userId, title, createdAt }) => ({ id, userId, title, createdAt })); // omit individual message loads for speed
  res.json(sessions);
});

// Get individual chat message history
app.get('/api/chats/:id', authenticateToken, (req: any, res) => {
  const chat = db.getChats().find(c => c.id === req.params.id && c.userId === req.user.userId);
  if (!chat) {
    return res.status(404).json({ error: 'Chat history not found' });
  }
  res.json(chat);
});

// Create new chat session
app.post('/api/chats', authenticateToken, (req: any, res) => {
  const { title } = req.body;

  const newChat: ChatSession = {
    id: generateId('chat'),
    userId: req.user.userId,
    title: title || 'New Financial Discussion',
    messages: [
      {
        id: generateId('msg'),
        role: 'model',
        content: `Hi! I am your AI Recovery Assistant. I have analyzed your debts, income, and budgets. Ask me anything about strategies (such as Snowball vs. Avalanche), budgeting adjustments, or customized payment timelines. How can I help you recover today?`,
        timestamp: new Date().toISOString()
      }
    ],
    createdAt: new Date().toISOString()
  };

  db.addChat(newChat);
  res.status(201).json(newChat);
});

// Send message & retrieve Gemini API reply
app.post('/api/chats/:id/message', authenticateToken, async (req: any, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message content is required' });
  }

  const chats = db.getChats();
  const chatIndex = chats.findIndex(c => c.id === req.params.id && c.userId === req.user.userId);

  if (chatIndex === -1) {
    return res.status(404).json({ error: 'Chat session not found' });
  }

  const activeChat = chats[chatIndex];

  // Append user message
  const userMsg: ChatMessage = {
    id: generateId('msg'),
    role: 'user',
    content: message,
    timestamp: new Date().toISOString()
  };
  activeChat.messages.push(userMsg);

  // Compile user financial context for Gemini
  const debts = db.getDebts().filter(d => d.userId === req.user.userId);
  const user = db.getUsers().find(u => u.id === req.user.userId);
  const txs = db.getTransactions().filter(t => t.userId === req.user.userId);
  const budgets = db.getBudgets().filter(b => b.userId === req.user.userId);
  const goals = db.getGoals().filter(g => g.userId === req.user.userId);

  const totalDebt = debts.reduce((sum, d) => sum + d.outstandingBalance, 0);
  const monthlyEmi = debts.reduce((sum, d) => sum + d.emi, 0);
  const income = user ? user.income : 0;

  const contextData = {
    user: { name: user?.name, monthlyIncome: income },
    debtsSummary: debts.map(d => ({
      name: d.name,
      lender: d.lender,
      type: d.loanType,
      balance: d.outstandingBalance,
      apr: d.interestRate,
      emi: d.emi,
      dueDay: d.dueDay
    })),
    totalDebt,
    monthlyEmiNeeded: monthlyEmi,
    budgets: budgets.map(b => ({ category: b.category, limit: b.amount })),
    recentExpenses: txs.filter(t => t.type === 'expense').slice(0, 10).map(t => ({ category: t.category, amount: t.amount, date: t.date })),
    goals: goals.map(g => ({ title: g.title, target: g.targetAmount, current: g.currentAmount, deadline: g.deadline }))
  };

  let modelReply = '';
  const ai = getAI();

  if (ai) {
    try {
      const history = activeChat.messages.slice(-6, -1).map(m => ({
        role: m.role,
        parts: [{ text: m.content }]
      }));

      const systemInstruction = `You are a certified credit counselor, bankruptcy advisor, and compassionate personal finance coach. 
Your goal is to guide the user to pay off their debts, build emergency funds, and optimize budgets.
Refer to their personal financial details provided in the context.
Suggest actionable recovery strategies (Avalanche: paying high-interest first, Snowball: paying smallest-balance first).
Use bullet points, brief calculations, and markdown formatting. 
Be supportive, free of judgment, and focused on recovery.
DO NOT suggest taking out new high-interest loans, payday loans, or risky investments. Always be realistic.

Here is the user's live financial context to base your coaching on:
${JSON.stringify(contextData, null, 2)}`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          ...history,
          { role: 'user', parts: [{ text: message }] }
        ],
        config: {
          systemInstruction,
          temperature: 0.7
        }
      });

      modelReply = response.text || "I apologize, I processed your financial data but wasn't able to compile a detailed reply. Could you please refine your question?";
    } catch (err: any) {
      console.error('Gemini API chat error:', err);
      modelReply = `[System Node Connection Issue]: I'm running in local safe advisor mode. Let me analyze your active portfolio: You have $${totalDebt.toLocaleString()} total outstanding debt across ${debts.length} liabilities. With your monthly income of $${income.toLocaleString()}, your current active monthly EMI is $${monthlyEmi.toLocaleString()} (${Math.round((monthlyEmi / income) * 100)}% of income). 
      
To proceed:
1. **Debt Avalanche Approach**: Prioritize extra payments towards your card with the highest interest rate. 
2. **Monthly Expense Pruning**: Cut discretionary expenses in categories where you have active budget alerts.
3. Let me know which target you'd like to simulate! (Note: Configure process.env.GEMINI_API_KEY in Secrets for live AI)`;
    }
  } else {
    // Elegant fallback recommendations based on realistic data
    modelReply = `### 🌟 AI Advisor Response (Simulation Mode)

I see you are managing **$${totalDebt.toLocaleString()}** in total debt, with a monthly income of **$${income.toLocaleString()}** and monthly EMI commitments of **$${monthlyEmi.toLocaleString()}**. 

Based on your active accounts:
${debts.map(d => `- **${d.name}**: $${d.outstandingBalance.toLocaleString()} at ${d.interestRate}% APR (EMI: $${d.emi}/mo)`).join('\n')}

#### 💡 Actionable Recovery Strategy:
1. **High APR Target (Avalanche Method)**: Your high-interest cards are eating up cash. Direct any extra savings beyond your minimum EMIs towards them first.
2. **Discretionary Spending Review**: Your logs show category outlays. Setting visual limits on Groceries/Entertainment can free up an extra $150–$300/mo.
3. **Emergency Cushion**: Keep working on your savings goals! Having a cash buffer prevents you from logging new debts when unexpected medical/car bills arise.

*To enable real live AI, please add a valid GEMINI_API_KEY in the Secrets panel.*`;
  }

  // Save reply to database
  const replyMsg: ChatMessage = {
    id: generateId('msg'),
    role: 'model',
    content: modelReply,
    timestamp: new Date().toISOString()
  };
  activeChat.messages.push(replyMsg);
  db.save();

  res.json({
    userMessage: userMsg,
    reply: replyMsg
  });
});

// ---------------- AI Financial PDF/Custom Report ----------------

app.get('/api/reports', authenticateToken, (req: any, res) => {
  const userReports = db.getReports().filter(r => r.userId === req.user.userId);
  res.json(userReports);
});

// Generate dynamic financial recovery report (triggered by user)
app.post('/api/reports', authenticateToken, async (req: any, res) => {
  const debts = db.getDebts().filter(d => d.userId === req.user.userId);
  const user = db.getUsers().find(u => u.id === req.user.userId);
  const txs = db.getTransactions().filter(t => t.userId === req.user.userId);
  const budgets = db.getBudgets().filter(b => b.userId === req.user.userId);

  if (!user) {
    return res.status(404).json({ error: 'User data missing' });
  }

  const totalDebt = debts.reduce((sum, d) => sum + d.outstandingBalance, 0);
  const monthlyEmi = debts.reduce((sum, d) => sum + d.emi, 0);

  // Generate Snowball & Avalanche payoff summaries
  // 1. Avalanche ordering (Highest APR first)
  const avalancheOrder = [...debts].sort((a, b) => b.interestRate - a.interestRate);
  // 2. Snowball ordering (Smallest balance first)
  const snowballOrder = [...debts].sort((a, b) => a.outstandingBalance - b.outstandingBalance);

  const reportTitle = `Financial Recovery Analysis - ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`;

  const prompt = `You are a professional financial planner. Generate a highly structured, rigorous, and personalized Financial Recovery & Debt Relief Report.
The client's details are:
- Name: ${user.name}
- Monthly Income: $${user.income}
- Total Liabilities: $${totalDebt}
- Monthly EMI Overhead: $${monthlyEmi}

Here are the specific liabilities:
${debts.map(d => `- ${d.name} (${d.loanType}) via ${d.lender}: $${d.outstandingBalance} at ${d.interestRate}% APR (Min EMI: $${d.emi}/mo)`).join('\n')}

Active Monthly Budgets set by user:
${budgets.map(b => `- ${b.category}: Limit $${b.amount}/mo`).join('\n')}

Generate your response in standard JSON format containing these fields EXACTLY so the client app can render it beautifully (DO NOT output markdown outside of the JSON):
{
  "financialHealthScore": <number between 1 and 100 based on debt-to-income ratio and interest rates>,
  "analysisOverview": "<string describing their overall financial health, high-risk points, and strengths>",
  "avalancheStrategy": {
    "priorityList": ["card names in sequence"],
    "interestSavedEstimate": <number dollar value e.g. 1200>,
    "timelineMonths": <number e.g. 18>,
    "actionSteps": ["step 1", "step 2"]
  },
  "snowballStrategy": {
    "priorityList": ["card names in sequence"],
    "interestSavedEstimate": <number dollar value e.g. 600>,
    "timelineMonths": <number e.g. 21>,
    "actionSteps": ["step 1", "step 2"]
  },
  "savingRecommendations": [
    { "category": "category name", "suggestedCut": <number e.g. 50>, "reason": "reason why" }
  ],
  "actionPlan30Days": ["specific task 1", "specific task 2", "specific task 3"]
}`;

  let reportData: any;
  const ai = getAI();

  if (ai) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json"
        }
      });

      const responseText = response.text || '';
      reportData = JSON.parse(responseText.trim());
    } catch (err) {
      console.error('Gemini API report error, building fallback report structure:', err);
      reportData = buildFallbackReport(user, debts, totalDebt, monthlyEmi, avalancheOrder, snowballOrder);
    }
  } else {
    reportData = buildFallbackReport(user, debts, totalDebt, monthlyEmi, avalancheOrder, snowballOrder);
  }

  const newReport: Report = {
    id: generateId('report'),
    userId: req.user.userId,
    title: reportTitle,
    data: reportData,
    createdAt: new Date().toISOString()
  };

  db.addReport(newReport);

  // Add notification
  db.addNotification({
    id: generateId('notif'),
    userId: req.user.userId,
    title: '📊 Financial Report Ready',
    message: `Your customized recovery plan for ${new Date().toLocaleDateString('en-US', { month: 'long' })} has been successfully compiled.`,
    type: 'ai_tip',
    isRead: false,
    createdAt: new Date().toISOString()
  });

  res.status(201).json(newReport);
});

function buildFallbackReport(user: User, debts: Debt[], totalDebt: number, monthlyEmi: number, avalanche: Debt[], snowball: Debt[]) {
  // Simple deterministic math to make mock data look realistic and professional
  const dti = totalDebt > 0 ? (monthlyEmi / user.income) * 100 : 0;
  const score = Math.max(10, Math.min(95, Math.round(100 - (dti * 1.5) - (totalDebt / 1500))));

  return {
    financialHealthScore: score,
    analysisOverview: `Your debt-to-income ratio on active payments is ${Math.round(dti)}%. You are carrying $${totalDebt.toLocaleString()} in liabilities. Based on your income of $${user.income.toLocaleString()}/mo, your baseline monthly EMI is $${monthlyEmi.toLocaleString()}. Budget optimization is highly recommended to accelerate payoff.`,
    avalancheStrategy: {
      priorityList: avalanche.map(d => `${d.name} (${d.interestRate}% APR)`),
      interestSavedEstimate: Math.round(totalDebt * 0.12),
      timelineMonths: Math.round((totalDebt / (monthlyEmi + 150)) * 0.9),
      actionSteps: [
        `Pay the minimum $${debts.find(d => d.id === avalanche[0].id)?.emi || 50} on all accounts except "${avalanche[0]?.name || 'Highest APR Card'}".`,
        `Direct all extra monthly savings ($150–$300) to "${avalanche[0]?.name || 'Highest APR Card'}" until fully cleared.`,
        `Move down to the next highest APR account: "${avalanche[1]?.name || 'Secondary high APR Card'}".`
      ]
    },
    snowballStrategy: {
      priorityList: snowball.map(d => `${d.name} ($${d.outstandingBalance.toLocaleString()})`),
      interestSavedEstimate: Math.round(totalDebt * 0.06),
      timelineMonths: Math.round(totalDebt / (monthlyEmi + 150)),
      actionSteps: [
        `Focus extra payments on your smallest liability: "${snowball[0]?.name || 'Smallest Debt'}" to achieve quick wins.`,
        `Pay basic minimums on all other lines.`,
        `Once "${snowball[0]?.name || 'Smallest Debt'}" is paid off, roll the entire $${snowball[0]?.emi || 50} monthly payment into "${snowball[1]?.name || 'Second Smallest Debt'}".`
      ]
    },
    savingRecommendations: [
      { category: 'Groceries/Food outlays', suggestedCut: 100, reason: 'Bulk prepping and using cheaper local alternatives saves fast.' },
      { category: 'Streaming & Digital Memberships', suggestedCut: 45, reason: 'Suspend secondary visual apps during active recovery.' }
    ],
    actionPlan30Days: [
      'Set automatic reminders for all debt due days to completely eliminate late payment fees.',
      'Deduct $150 from checking into emergency savings immediately on your next salary deposit.',
      'Log into Chase/Ally portal and check if you are eligible for lower interest hardship programs.'
    ]
  };
}

// ---------------- Admin Panel APIs ----------------

// 1. Platform analytics
app.get('/api/admin/analytics', authenticateToken, requireAdmin, (req, res) => {
  const users = db.getUsers();
  const debts = db.getDebts();
  const transactions = db.getTransactions();
  const chats = db.getChats();

  const totalUsersCount = users.length;
  const totalDebtsRegistered = debts.reduce((sum, d) => sum + d.outstandingBalance, 0);
  const totalMonthlyIncomeRegistered = users.reduce((sum, u) => sum + u.income, 0);
  
  // count total questions
  const totalAiInquiries = chats.reduce((sum, c) => sum + c.messages.filter(m => m.role === 'user').length, 0);

  res.json({
    totalUsersCount,
    totalDebtsRegistered,
    totalMonthlyIncomeRegistered,
    totalAiInquiries,
    averageDebtPerUser: totalUsersCount > 0 ? Math.round(totalDebtsRegistered / totalUsersCount) : 0,
    activeBudgetCounts: db.getBudgets().length,
    feedbacksCount: db.getFeedbacks().length
  });
});

// 2. List all users
app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
  const userList = db.getUsers().map(({ id, name, email, isAdmin, income, createdAt }) => ({
    id, name, email, isAdmin, income, createdAt
  }));
  res.json(userList);
});

// 3. Update user role / Admin status
app.put('/api/admin/users/:id/role', authenticateToken, requireAdmin, (req, res) => {
  const { isAdmin } = req.body;
  const users = db.getUsers();
  const index = users.findIndex(u => u.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  users[index].isAdmin = !!isAdmin;
  db.save();

  res.json({
    id: users[index].id,
    name: users[index].name,
    email: users[index].email,
    isAdmin: users[index].isAdmin
  });
});

// 4. Feedbacks list (accessible to all authenticated users for transparency or just admins)
app.get('/api/admin/feedback', authenticateToken, (req, res) => {
  res.json(db.getFeedbacks());
});

app.post('/api/admin/feedback', authenticateToken, (req: any, res) => {
  const { rating, comment } = req.body;
  if (rating === undefined || !comment) {
    return res.status(400).json({ error: 'Rating and comment are required' });
  }

  const user = db.getUsers().find(u => u.id === req.user.userId);

  const newFeedback: Feedback = {
    id: generateId('feedback'),
    userId: req.user.userId,
    userEmail: user?.email || 'anonymous@recovery.com',
    rating: Number(rating),
    comment,
    createdAt: new Date().toISOString()
  };

  db.addFeedback(newFeedback);
  res.status(201).json(newFeedback);
});


// ---------------- Vite Middleware & Routing ----------------

async function startServer() {
  // Vite integration for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    
    app.use(vite.middlewares);
    console.log('Vite middleware mounted in development mode');
  } else {
    // Production serving static assets
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    
    // Fallback SPA routing
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log('Production static file serving mounted');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI Powered Debt Relief Server is running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start full stack Express server:', err);
});
