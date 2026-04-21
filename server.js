import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const QUIZAPI_KEY = process.env.QUIZAPI_KEY || "";
const QUIZAPI_BASE = "https://quizapi.io/api/v1/questions";
const LEETCODE_GQL = "https://leetcode.com/graphql";
const OPENTRIVIA_BASE = "https://opentdb.com/api.php";
const CODEFORCES_BASE = "https://codeforces.com/api";

// ══════════════════════════════════════════════════════════════
//   UTILITIES
// ══════════════════════════════════════════════════════════════

function delay() { return new Promise(r => setTimeout(r, 200 + Math.random() * 300)); }

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => "\n" + c.replace(/<[^>]*>/g, "").trim() + "\n")
    .replace(/<li[^>]*>/gi, "\n• ").replace(/<p[^>]*>/gi, "\n").replace(/<\/p>/gi, "")
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "$1").replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "$1")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// Decode HTML entities from OpenTrivia & other APIs
function decodeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&ldquo;/g, "\u201C")
    .replace(/&rdquo;/g, "\u201D").replace(/&lsquo;/g, "\u2018").replace(/&rsquo;/g, "\u2019")
    .replace(/&mdash;/g, "\u2014").replace(/&ndash;/g, "\u2013").replace(/&hellip;/g, "\u2026")
    .replace(/&nbsp;/g, " ").replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/");
}

function getApiDifficulty(experience, qNum, selfLevel) {
  // Freshers: first 2 questions are always Beginner diagnostic regardless of self-level
  if (experience === "Fresher" && qNum < 2) return "Easy";
  if (experience === "Experienced") return qNum >= 3 ? "Hard" : "Medium";
  if (selfLevel === "Advanced") return "Medium";
  return "Easy";
}

// Fresher diagnostic topics per track (used for Q0 and Q1)
const FRESHER_DIAGNOSTIC = {
  "Java":        ["What is the difference between JDK, JRE, and JVM?", "What is OOP? Name 4 pillars of OOP in Java."],
  "JavaScript":  ["What is the difference between let, var, and const in JavaScript?", "Explain what a callback function is and give an example."],
  "Python":      ["What is the difference between a list and a tuple in Python?", "Explain Python's indentation rule and why it matters."],
  "SQL":         ["What is the difference between WHERE and HAVING in SQL?", "Explain the difference between INNER JOIN and LEFT JOIN with an example."],
  "PL-SQL":      ["What is PL/SQL? How does it differ from regular SQL?", "What is a cursor in PL/SQL? When would you use it?"],
  "WMS":         ["What is a Warehouse Management System? Name 3 core functions.", "What is the difference between a Receipt and a Put-Away in WMS?"],
  "Oracle SCM":  ["What is Supply Chain Management? Name its 5 key stages.", "What is a Purchase Order and how does it flow in Oracle SCM?"],
  "HCM":         ["What is Human Capital Management? Name 3 modules in Oracle HCM.", "What is the difference between an Employee and a Contingent Worker in HCM?"],
  "Fixed Assets":["What is a Fixed Asset? Give 3 examples.", "What is depreciation and what are the common depreciation methods?"]
};

const TECH_TAG_MAP = {
  "Java": "Java", "JavaScript": "JavaScript", "Python": "Python", "SQL": "SQL",
  "Spring Boot": "Java", "React": "JavaScript", "Angular": "JavaScript",
  "Vue": "JavaScript", "Node.js": "JavaScript", "Oracle DB": "SQL",
  "AWS": "DevOps", "Azure": "DevOps", "GCP": "DevOps",
  "Docker/Kubernetes": "Docker", "C#/.NET": "CSharp", "PHP": "PHP",
  "Go": "Golang", "TypeScript": "JavaScript"
};

// ══════════════════════════════════════════════════════════════
//   SMART QUESTION TYPE SELECTOR
//   Developer (Java/JS): 40% MCQ, 30% descriptive, 20% code, 10% LeetCode
//   Developer (SQL): 40% MCQ, 40% descriptive, 20% code  (no DSA LeetCode)
//   Developer (Python): 40% MCQ, 35% descriptive, 25% code (no LC)
//   Functional: 60% scenario, 40% MCQ
// ══════════════════════════════════════════════════════════════

const LC_ELIGIBLE_TRACKS = new Set(["Java", "JavaScript", "TypeScript", "Go", "C#/.NET", "PHP", "Python"]);

function pickType(role, track) {
  const r = Math.random();
  if (role === "functional") return r < 0.6 ? "scenario" : "mcq";
  // SQL / PL-SQL: no LeetCode DSA — keep SQL-domain questions only
  if (track === "SQL" || track === "PL-SQL" || track === "Oracle DB") {
    if (r < 0.40) return "mcq";
    if (r < 0.75) return "descriptive";
    return "code";
  }
  // LeetCode only for algorithm-friendly languages
  if (LC_ELIGIBLE_TRACKS.has(track)) {
    if (r < 0.40) return "mcq";
    if (r < 0.70) return "descriptive";
    if (r < 0.90) return "code";
    return "leetcode";
  }
  // Fallback for any other developer track
  if (r < 0.45) return "mcq";
  if (r < 0.80) return "descriptive";
  return "code";
}

// True random shuffle helper
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function selectFromDB(role, track, difficulty, usedIds, preferType) {
  const LEVELS = ["Beginner", "Intermediate", "Advanced"];
  const diffLevel = difficulty === "Easy" ? "Beginner" : difficulty === "Hard" ? "Advanced" : "Intermediate";
  const allowed = LEVELS.slice(0, LEVELS.indexOf(diffLevel) + 1);
  const trackLC = (track || "").toLowerCase();

  // STRICT: only same-role + same-track. Never cross track.
  const sameTrack = LOCAL_DB.filter(q => q.role === role && q.track.toLowerCase() === trackLC);

  // Not seen yet + correct difficulty + preferred type
  const fresh = sameTrack.filter(q => !usedIds.includes(q.id) && allowed.includes(q.level));
  const typedFresh = fresh.filter(q => q.type === preferType);
  if (typedFresh.length > 0) return shuffle(typedFresh)[0];
  if (fresh.length > 0) return shuffle(fresh)[0];

  // Seen already but correct difficulty (allow repeat — better than cross-track)
  const diffOnly = sameTrack.filter(q => allowed.includes(q.level));
  if (diffOnly.length > 0) return shuffle(diffOnly)[0];

  // Any question from this track (last resort, still track-strict)
  if (sameTrack.length > 0) return shuffle(sameTrack)[0];

  // No question found for this track in local DB — return null so API sources handle it
  console.warn(`[selectFromDB] No local questions for role=${role} track=${track} — will fall through to APIs`);
  return null;
}

// ══════════════════════════════════════════════════════════════
//   API FETCHERS
// ══════════════════════════════════════════════════════════════

async function fetchFromQuizAPI(tag, difficulty) {
  if (!QUIZAPI_KEY || QUIZAPI_KEY === "your_quizapi_key_here") return null;
  try {
    const url = `${QUIZAPI_BASE}?apiKey=${QUIZAPI_KEY}&tags=${encodeURIComponent(tag)}&limit=5&difficulty=${difficulty}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const q = data[Math.floor(Math.random() * data.length)];
    const options = []; const letters = ["A","B","C","D"];
    let ca = "A"; let caText = "";
    let i = 0;
    for (const [key, val] of Object.entries(q.answers || {})) {
      if (val && i < 4) {
        options.push(`${letters[i]}. ${val}`);
        if (q.correct_answers?.[key + "_correct"] === "true") { ca = letters[i]; caText = val; }
        i++;
      }
    }
    if (options.length < 2) return null;
    return {
      id: `qa_${q.id}`, source: "QuizAPI", role: "developer", track: tag,
      level: difficulty === "Easy" ? "Beginner" : difficulty === "Hard" ? "Advanced" : "Intermediate",
      type: "mcq", title: `[${tag}] ${q.question.substring(0, 65)}`, text: q.question,
      options, correctAnswer: ca,
      correctAnswerText: `✅ Correct: "${caText}". ${q.explanation || ""}`,
      expected: [tag.toLowerCase()], hint: (q.explanation || "").substring(0, 120) || `Core ${tag} concept.`
    };
  } catch (e) { return null; }
}

// Maps developer track → LeetCode categorySlug
const LC_CATEGORY = { "SQL": "database", "PL-SQL": "database", "Oracle DB": "database" };

async function fetchFromLeetCode(difficulty, track) {
  try {
    const lcDiff = difficulty === "Easy" ? "EASY" : difficulty === "Hard" ? "HARD" : "MEDIUM";
    const cat = LC_CATEGORY[track] || "algorithms";
    // NOTE: LeetCode GraphQL requires categorySlug as a string literal, not a variable
    const queryStr = `query randomQuestion($filters: QuestionListFilterInput) {
      randomQuestion(categorySlug: "${cat}", filters: $filters) {
        title titleSlug difficulty topicTags { name } exampleTestcases hints
      }
    }`;
    const res = await fetch(LEETCODE_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Referer": "https://leetcode.com",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      body: JSON.stringify({ query: queryStr, variables: { filters: { difficulty: lcDiff } } }),
      signal: AbortSignal.timeout(7000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const lc = data?.data?.randomQuestion;
    if (!lc?.titleSlug) return null;

    const tags = (lc.topicTags || []).map(t => t.name);
    const problemUrl = `https://leetcode.com/problems/${lc.titleSlug}/`;
    let testCases = "";
    if (lc.exampleTestcases) {
      testCases = lc.exampleTestcases.trim().split("\n")
        .filter(Boolean).map((c, i) => `  Case ${i + 1}: ${c}`).join("\n");
    }
    // content is not returned without auth — build a rich prompt from metadata
    const topicStr = tags.join(", ") || "Algorithms";
    const questionText = [
      `Solve the LeetCode problem: "${lc.title}".`,
      `\nDifficulty: ${lc.difficulty} | Category: ${cat === "database" ? "SQL / Database" : "Algorithms & Data Structures"} | Topics: ${topicStr}`,
      `\n🔗 Full problem at: ${problemUrl}`,
      testCases ? `\n\nSample Test Cases:\n${testCases}` : "",
      `\n\nFor this problem, explain:\n` +
      (cat === "database"
        ? `1. 📋 What SQL logic / approach would you use\n2. 🔗 Which JOINs or aggregations apply\n3. 🧪 Edge cases: NULL values, empty tables, duplicates`
        : `1. 📐 Algorithm / Approach — What strategy?\n2. ⏱️ Time Complexity — Big O notation\n3. 📦 Space Complexity — Extra memory used\n4. 🧪 Edge Cases — At least 2 (empty, single element, overflow)`)
    ].join("");

    return {
      id: `lc_${lc.titleSlug}`, source: "LeetCode", sourceUrl: problemUrl,
      role: "developer", track: track || "Coding", level: difficulty, type: "leetcode",
      title: lc.title, lcDifficulty: lc.difficulty, topicTags: tags, problemUrl,
      text: questionText, testCases,
      answerPrompt: cat === "database"
        ? `Explain: 1. SQL approach  2. JOINs used  3. Edge cases (NULLs, duplicates)`
        : `Explain: 1. Algorithm  2. Time complexity  3. Space complexity  4. Edge cases`,
      expected: cat === "database" ? ["join", "sql", "query"] : ["algorithm", "complexity", "edge case"],
      hint: lc.hints?.length ? lc.hints[0] : `Topics: ${topicStr}. Open the link to read the full problem.`,
      correctAnswerText: `See the full solution and editorial at: ${problemUrl}\n\nKey topics: ${topicStr}.`
    };
  } catch (e) {
    console.error("LeetCode fetch error:", e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//   OPEN TRIVIA DB  (Free, no API key — Computer Science MCQs)
//   category=18 = Science: Computers  |  HTTPS | CORS: Yes
// ══════════════════════════════════════════════════════════════

async function fetchFromOpenTrivia(difficulty, track) {
  try {
    const diff = difficulty === "Easy" ? "easy" : difficulty === "Hard" ? "hard" : "medium";
    const url = `${OPENTRIVIA_BASE}?amount=1&category=18&difficulty=${diff}&type=multiple`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.response_code !== 0 || !data.results?.length) return null;

    const q = data.results[0];
    const question = decodeHtml(q.question);
    const correct = decodeHtml(q.correct_answer);
    const incorrects = q.incorrect_answers.map(decodeHtml);

    // Shuffle all options and assign letter labels
    const all = [correct, ...incorrects].sort(() => Math.random() - 0.5);
    const letters = ["A", "B", "C", "D"];
    const options = all.map((opt, i) => `${letters[i]}. ${opt}`);
    const correctLetter = letters[all.indexOf(correct)];

    return {
      id: `otdb_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      source: "OpenTrivia",
      role: "developer", track: track || "General CS",
      level: difficulty === "Easy" ? "Beginner" : difficulty === "Hard" ? "Advanced" : "Intermediate",
      type: "mcq",
      title: question.length > 90 ? question.substring(0, 90) + "..." : question,
      text: question,
      options, correctAnswer: correctLetter,
      correctAnswerText: `✅ Correct Answer: "${correct}".\n\nThis is a Computer Science MCQ. The other options were: ${incorrects.join(", ")}.`,
      expected: [track?.toLowerCase() || "computer science"],
      hint: `Category: Science & Computers (difficulty: ${q.difficulty}). Think about fundamental concepts.`
    };
  } catch (e) {
    console.error("OpenTrivia fetch error:", e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//   CODEFORCES  (Free, apiKey optional for higher limits)
//   Provides real competitive programming problems with full statements
// ══════════════════════════════════════════════════════════════

// Maps track → relevant Codeforces tags for filtering
const CF_TAG_MAP = {
  "Java": ["implementation", "strings"],
  "JavaScript": ["implementation", "constructive algorithms"],
  "Python": ["dynamic programming", "greedy"],
  "SQL": null,  // Codeforces has no SQL problems
  "General": ["sorting", "greedy", "binary search"]
};

async function fetchFromCodeforces(difficulty, track) {
  if (track === "SQL" || track === "PL-SQL") return null;  // CF has no SQL problems
  try {
    // Codeforces difficulty: A=Easy (800-1200), B=Med (1300-1800), C=Hard (1900-2500)
    const maxRating = difficulty === "Easy" ? 1200 : difficulty === "Hard" ? 2400 : 1800;
    const minRating = difficulty === "Easy" ? 800 : difficulty === "Hard" ? 1900 : 1300;
    const tags = CF_TAG_MAP[track] || CF_TAG_MAP["General"];
    const tagParam = tags ? `&tags=${encodeURIComponent(tags[Math.floor(Math.random() * tags.length)])}` : "";
    const url = `${CODEFORCES_BASE}/problemset.problems?${tagParam}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "OK" || !data.result?.problems?.length) return null;

    // Filter by rating range and only those with a statement accessible
    const pool = data.result.problems.filter(p =>
      p.rating && p.rating >= minRating && p.rating <= maxRating && p.contestId
    );
    if (pool.length === 0) return null;

    const p = pool[Math.floor(Math.random() * pool.length)];
    const problemUrl = `https://codeforces.com/problemset/problem/${p.contestId}/${p.index}`;
    const topicStr = (p.tags || []).join(", ") || "Algorithms";

    return {
      id: `cf_${p.contestId}_${p.index}`,
      source: "Codeforces", sourceUrl: problemUrl,
      role: "developer", track: track || "Coding",
      level: difficulty, type: "leetcode",  // reuse 'leetcode' type for display
      title: p.name,
      lcDifficulty: `Rating: ${p.rating}`,
      topicTags: p.tags || [],
      problemUrl,
      text: [
        `Solve the Codeforces problem: "${p.name}" (Rating: ${p.rating}).`,
        `\n🔗 Full problem statement at: ${problemUrl}`,
        `\n🏷️ Tags: ${topicStr}`,
        `\n\nAfter reading the problem, explain:\n`,
        `1. 📐 Approach / Algorithm — what strategy (greedy, DP, BFS, etc.)?`,
        `\n2. ⏱️ Time & Space Complexity — Big O?`,
        `\n3. 🧪 Key Observations — What makes this problem unique?`,
        `\n4. 💻 Pseudocode / Key Steps — Outline your solution.`
      ].join(""),
      testCases: "",
      expected: ["algorithm", "complexity", "approach"],
      hint: `Codeforces problem tags: ${topicStr}. Open the link to read the full statement.`,
      correctAnswerText: `See editorial for ${p.name} at: ${problemUrl}\n\nKey topics: ${topicStr}. Rating: ${p.rating}.`
    };
  } catch (e) {
    console.error("Codeforces fetch error:", e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
//   LOCAL QUESTION DATABASE  (Developer + Functional)
// ══════════════════════════════════════════════════════════════

const LOCAL_DB = [
  // ╔══════════ JAVA ══════════╗
  { id:"j1", role:"developer", track:"Java", level:"Beginner", type:"mcq",
    title:"HashMap: Null Handling",
    text:"Which statement about Java HashMap is CORRECT?",
    options:["A. Allows multiple null keys","B. Allows one null key and multiple null values","C. Null keys throw NullPointerException","D. Null values are not permitted"],
    correctAnswer:"B",
    correctAnswerText:"✅ HashMap allows exactly ONE null key and unlimited null values. Hashtable allows neither. LinkedHashMap also allows one null key.",
    expected:["null","HashMap"], hint:"Compare HashMap vs Hashtable for null handling." },

  { id:"j2", role:"developer", track:"Java", level:"Beginner", type:"descriptive",
    title:"Null Safety — Optional",
    text:"Your production API crashes with NullPointerException when a user has no email. Explain TWO Java techniques to prevent this and write a code example for one.",
    expected:["Optional","null check","ofNullable","if"],
    correctAnswerText:"✅ Two approaches: 1) if(email != null) check, 2) Optional.ofNullable(user.getEmail()).orElse('N/A'). Optional is preferred in modern Java as it makes nullability explicit in the API contract.",
    hint:"Java 8+ introduced Optional<T> to make nullability part of the type signature." },

  { id:"j3", role:"developer", track:"Java", level:"Intermediate", type:"code",
    title:"Static Cache Memory Leak",
    code:"private static final Map<String, Session> cache = new HashMap<>();\npublic void addSession(String id) {\n    cache.put(id, new Session(id));\n    // no eviction logic\n}",
    text:"This server code runs for weeks. Identify the exact problem and propose two ways to fix it.",
    expected:["static","grow","eviction","WeakHashMap","bounded","LRU"],
    correctAnswerText:"✅ Problem: static Map grows forever — no entries are ever removed. Fix 1: Use a bounded cache (LinkedHashMap with removeEldestEntry). Fix 2: Use WeakHashMap so GC can remove entries. Fix 3: Use Caffeine/Guava cache with TTL.",
    hint:"The static keyword persists this Map for the entire JVM lifetime." },

  { id:"j4", role:"developer", track:"Java", level:"Intermediate", type:"mcq",
    title:"Checked vs Unchecked Exceptions",
    text:"Which of these MUST be caught or declared with 'throws' in the method signature?",
    options:["A. NullPointerException","B. ArrayIndexOutOfBoundsException","C. IOException","D. StackOverflowError"],
    correctAnswer:"C",
    correctAnswerText:"✅ IOException is a checked exception — the compiler enforces handling. NPE and AIOOBE are unchecked RuntimeExceptions. StackOverflowError is an Error (not Exception).",
    expected:["checked","IOException"], hint:"Checked exceptions extend Exception directly, not RuntimeException." },

  { id:"j5", role:"developer", track:"Java", level:"Advanced", type:"descriptive",
    title:"synchronized vs ReentrantLock",
    text:"Two threads call the same synchronized method simultaneously. What happens? Give two concrete scenarios where ReentrantLock is a better choice than synchronized.",
    expected:["monitor","tryLock","fairness","reentrant","timeout"],
    correctAnswerText:"✅ With synchronized: second thread blocks on the object's monitor lock until first thread exits. ReentrantLock is better when: 1) You need tryLock() with timeout (non-blocking acquisition), 2) You need fairness policy (threads served in order).",
    hint:"ReentrantLock.tryLock(100ms) can fail gracefully rather than blocking forever." },

  { id:"j6", role:"developer", track:"Java", level:"Beginner", type:"mcq",
    title:"== vs .equals()",
    text:"What does new String(\"hello\") == new String(\"hello\") return?",
    options:["A. true — same characters","B. false — compares references, not content","C. Depends on JVM version","D. Compilation error"],
    correctAnswer:"B",
    correctAnswerText:"✅ == compares object references (memory addresses). Two 'new' String objects are always different objects in memory. Use .equals() to compare string content.",
    expected:["reference","equals","content"], hint:"new String() always creates a new object on the heap." },

  { id:"j7", role:"developer", track:"Java", level:"Intermediate", type:"mcq",
    title:"ArrayList vs LinkedList",
    text:"For 100,000 frequent insertions at the MIDDLE of a list, which performs better?",
    options:["A. ArrayList — cache-friendly array","B. LinkedList — O(1) insert after finding position","C. They are equal","D. Use HashMap instead"],
    correctAnswer:"B",
    correctAnswerText:"✅ LinkedList O(1) insert at a node position (just pointer change). But finding the middle is O(n). ArrayList shifting is O(n) each time. For bulk middle insertions, LinkedList wins on insert cost.",
    expected:["LinkedList","O(1)","shift"], hint:"Think about what happens when you insert in the middle of an ArrayList — every element after must shift." },

  { id:"j8", role:"developer", track:"Java", level:"Intermediate", type:"code",
    title:"Stream API — Filter and Transform",
    code:"List<Employee> employees = getEmployees();\n// TODO: Get names of active employees earning > 50000\n// sorted alphabetically, as uppercase strings",
    text:"Complete this using Java Stream API. Show the full chain of stream operations needed.",
    expected:["filter","map","sorted","collect","toUpperCase","Collectors"],
    correctAnswerText:"✅ Solution:\nemployees.stream()\n  .filter(e -> e.isActive() && e.getSalary() > 50000)\n  .map(e -> e.getName().toUpperCase())\n  .sorted()\n  .collect(Collectors.toList());",
    hint:"Streams: filter() → map() → sorted() → collect(). Order matters." },

  { id:"j9", role:"developer", track:"Java", level:"Advanced", type:"code",
    title:"Thread-Safe Singleton",
    code:"public class Config {\n    private static Config instance;\n    private Config() {}\n    public static Config getInstance() {\n        if (instance == null)\n            instance = new Config();\n        return instance;\n    }\n}",
    text:"This singleton is NOT thread-safe. Two threads can create two instances. Fix it using the most efficient Java approach.",
    expected:["volatile","synchronized","double-checked","static holder","enum"],
    correctAnswerText:"✅ Best fix — Static Holder pattern:\nprivate static class Holder { static final Config INSTANCE = new Config(); }\npublic static Config getInstance() { return Holder.INSTANCE; }\nAlternatively: double-checked locking with 'volatile' on the field.",
    hint:"The static holder pattern leverages class loading guarantees for thread safety without synchronization overhead." },

  { id:"j10", role:"developer", track:"Java", level:"Beginner", type:"mcq",
    title:"String Immutability",
    text:"Why is String immutable in Java?",
    options:["A. To allow sharing in the String pool safely","B. To prevent any comparisons","C. Because Java doesn't support mutable strings","D. To save memory by never creating new objects"],
    correctAnswer:"A",
    correctAnswerText:"✅ Strings are immutable so they can safely be shared across the String pool. Since multiple references can point to the same String, mutation would be dangerous. It also makes Strings safe as HashMap keys.",
    expected:["pool","immutable","shared"], hint:"Think about string interning and the String constant pool." },

  // ╔══════════ JAVASCRIPT ══════════╗
  { id:"js1", role:"developer", track:"JavaScript", level:"Beginner", type:"mcq",
    title:"var Hoisting in setTimeout",
    text:"What does this output?\n\nfor (var i = 0; i < 3; i++) {\n  setTimeout(() => console.log(i), 100);\n}",
    options:["A. 0 1 2","B. 3 3 3","C. undefined x3","D. ReferenceError"],
    correctAnswer:"B",
    correctAnswerText:"✅ Output: 3 3 3. var is function-scoped, not block-scoped. All three closures share the SAME i variable. By the time callbacks run (after loop), i = 3. Fix: use let (block-scoped) or an IIFE.",
    expected:["var","closure","let"], hint:"What is i's value after the loop finishes?" },

  { id:"js2", role:"developer", track:"JavaScript", level:"Beginner", type:"descriptive",
    title:"Event Loop Explained",
    text:"Explain the JavaScript Event Loop. What is the execution order of: synchronous code, Promises (.then), and setTimeout callbacks?",
    expected:["call stack","microtask","macrotask","Promise","setTimeout"],
    correctAnswerText:"✅ Order: 1) Synchronous code (call stack), 2) Microtasks (Promise .then), 3) Macrotasks (setTimeout/setInterval). Example: console.log('1') → Promise.resolve().then(()=>console.log('2')) → setTimeout(()=>console.log('3')) prints: 1, 2, 3.",
    hint:"Microtasks (Promises) always run before macrotasks (setTimeout), even with delay=0." },

  { id:"js3", role:"developer", track:"JavaScript", level:"Intermediate", type:"code",
    title:"Promise.all vs allSettled",
    code:"const results = await Promise.all([\n  fetchOrders(),\n  fetchBrokenInventoryAPI()\n]);",
    text:"This code fails silently in production if one endpoint is down. Why? Rewrite it to handle partial failures and extract only successful responses.",
    expected:["allSettled","fulfilled","fail-fast","reject"],
    correctAnswerText:"✅ Promise.all is fail-fast — one rejection cancels ALL. Fix:\nconst results = await Promise.allSettled([fetchOrders(), fetchInventory()]);\nconst successes = results.filter(r => r.status === 'fulfilled').map(r => r.value);",
    hint:"allSettled never rejects — it always resolves with an array of status objects." },

  { id:"js4", role:"developer", track:"JavaScript", level:"Intermediate", type:"mcq",
    title:"typeof null",
    text:"What does typeof null return in JavaScript?",
    options:["A. 'null'","B. 'undefined'","C. 'object'","D. 'boolean'"],
    correctAnswer:"C",
    correctAnswerText:"✅ typeof null returns 'object' — this is a famous JavaScript bug from the original design that was kept for backward compatibility. Use val === null for null checks.",
    expected:["typeof","null","object","bug"], hint:"This is a well-known JavaScript quirk that dates back to 1995." },

  { id:"js5", role:"developer", track:"JavaScript", level:"Intermediate", type:"mcq",
    title:"Debounce vs Throttle",
    text:"Implementing a live search that calls an API on every keystroke. To avoid too many requests, you should:",
    options:["A. Throttle — fires at a fixed rate","B. Debounce — waits for pause in typing","C. Memoize — cache repeated queries","D. Batch — group multiple calls into one"],
    correctAnswer:"B",
    correctAnswerText:"✅ Debounce waits until the user STOPS typing (silence period). For search: call API only after 300ms pause. Throttle would fire every 300ms during typing regardless.",
    expected:["debounce","silence","delay"], hint:"You want to fire AFTER the user finishes typing, not during." },

  { id:"js6", role:"developer", track:"JavaScript", level:"Advanced", type:"code",
    title:"Custom EventEmitter",
    text:"Implement a JavaScript EventEmitter class with: on(event, fn), emit(event, ...args), and off(event, fn) methods. How do you prevent memory leaks from accumulated listeners?",
    expected:["Map","Set","on","emit","off","WeakRef"],
    correctAnswerText:"✅ class EventEmitter {\n  constructor() { this.events = new Map(); }\n  on(e, fn) { if (!this.events.has(e)) this.events.set(e, new Set()); this.events.get(e).add(fn); }\n  emit(e, ...a) { this.events.get(e)?.forEach(fn => fn(...a)); }\n  off(e, fn) { this.events.get(e)?.delete(fn); }\n}\nMemory leak prevention: always call off() or use off after once() patterns.",
    hint:"Use Map<event, Set<listener>> to store handlers. Set prevents duplicates and has O(1) delete." },

  { id:"js7", role:"developer", track:"JavaScript", level:"Advanced", type:"descriptive",
    title:"Prototype Chain",
    text:"Explain how JavaScript prototype chain works. What happens when you access obj.toString() on a plain object? How does class syntax relate to the prototype chain?",
    expected:["prototype","__proto__","Object.prototype","chain","class"],
    correctAnswerText:"✅ Every object has [[Prototype]]. Accessing obj.toString(): 1) Check own properties → 2) Follow [[Prototype]] to Object.prototype → 3) Find toString there. class is syntactic sugar over prototype-based inheritance — it creates constructor functions and sets up prototype chains automatically.",
    hint:"class A extends B is equivalent to A.prototype.__proto__ = B.prototype." },

  // ╔══════════ SQL ══════════╗
  { id:"sq1", role:"developer", track:"SQL", level:"Beginner", type:"mcq",
    title:"GROUP BY Aggregate Rule",
    text:"Which query correctly retrieves total sales per region?",
    options:["A. SELECT region, SUM(amount) FROM sales","B. SELECT region, SUM(amount) FROM sales GROUP BY region","C. SELECT SUM(amount) FROM sales WHERE region='E'","D. SELECT region FROM sales ORDER BY SUM(amount)"],
    correctAnswer:"B",
    correctAnswerText:"✅ Every non-aggregate column in SELECT must appear in GROUP BY. Without GROUP BY, the DB doesn't know how to group rows for the SUM.",
    expected:["GROUP BY","aggregate"], hint:"Rule: non-aggregate SELECT columns must be in GROUP BY." },

  { id:"sq2", role:"developer", track:"SQL", level:"Beginner", type:"mcq",
    title:"HAVING vs WHERE",
    text:"To list departments with more than 10 employees, you need:",
    options:["A. WHERE COUNT(*) > 10","B. HAVING COUNT(*) > 10","C. WHERE employees > 10","D. FILTER COUNT(*) > 10"],
    correctAnswer:"B",
    correctAnswerText:"✅ HAVING filters AFTER grouping (post-aggregation). WHERE filters BEFORE grouping (individual rows). You can't use aggregate functions in WHERE — use HAVING for that.",
    expected:["HAVING","aggregate","filter"], hint:"WHERE = before grouping. HAVING = after grouping." },

  { id:"sq3", role:"developer", track:"SQL", level:"Intermediate", type:"mcq",
    title:"Function on Indexed Column",
    text:"Why does this query NOT use the index on 'email'?\nSELECT * FROM users WHERE UPPER(email) = 'A@B.COM'",
    options:["A. VARCHAR columns can't be indexed","B. UPPER() breaks sargability — function applied to indexed column prevents index use","C. SELECT * always causes full scan","D. Emails must use LIKE not ="],
    correctAnswer:"B",
    correctAnswerText:"✅ Wrapping an indexed column in a function (UPPER, LOWER, TRIM, TO_CHAR) prevents the optimizer from using the index. Solution: Store emails lowercase and compare lowercase input, or create a function-based index.",
    expected:["sargable","function","UPPER","index"], hint:"The optimizer can't match transformed values to the raw B-tree index entries." },

  { id:"sq4", role:"developer", track:"SQL", level:"Intermediate", type:"code",
    title:"N+1 Query Problem",
    code:"-- App code fetches all orders:\nSELECT * FROM orders;\n-- Then for EACH order (in app loop):\nSELECT * FROM items WHERE order_id = {order.id};",
    text:"This causes N+1 database queries for N orders. Rewrite as a single SQL using JOIN and explain the performance impact.",
    expected:["JOIN","single","N+1","round-trip","LEFT JOIN"],
    correctAnswerText:"✅ Single query:\nSELECT o.*, i.* FROM orders o\nLEFT JOIN items i ON i.order_id = o.id;\nImpact: N+1 = N database round trips (network latency × N). One JOIN = 1 round trip. For 1000 orders, that's 1000× fewer network calls.",
    hint:"JOIN in SQL is always faster than looping in application code." },

  { id:"sq5", role:"developer", track:"SQL", level:"Advanced", type:"code",
    title:"PL/SQL BULK COLLECT",
    code:"-- Slow: 100,000 rows processed one at a time\nFOR rec IN (SELECT * FROM items WHERE status='PENDING') LOOP\n  UPDATE items SET status='DONE' WHERE item_id = rec.item_id;\n  COMMIT;  -- worst practice\nEND LOOP;",
    text:"Rewrite this PL/SQL using BULK COLLECT and FORALL for batch processing. Why is the in-loop COMMIT particularly harmful?",
    expected:["BULK COLLECT","FORALL","LIMIT","COMMIT","redo","batch"],
    correctAnswerText:"✅ DECLARE\n  TYPE t_ids IS TABLE OF items.item_id%TYPE;\n  l_ids t_ids;\nBEGIN\n  SELECT item_id BULK COLLECT INTO l_ids FROM items WHERE status='PENDING' LIMIT 1000;\n  FORALL i IN 1..l_ids.COUNT\n    UPDATE items SET status='DONE' WHERE item_id = l_ids(i);\n  COMMIT;\nEND;\nIn-loop COMMIT is deadly: each COMMIT flushes redo logs, destroying the optimizer's ability to batch.",
    hint:"BULK COLLECT + FORALL reduces context switches from N to ~1 per batch." },

  { id:"sq6", role:"developer", track:"SQL", level:"Beginner", type:"mcq",
    title:"NULL Comparison",
    text:"Which SQL correctly finds rows where 'manager_id' is NULL?",
    options:["A. WHERE manager_id = NULL","B. WHERE manager_id IS NULL","C. WHERE manager_id == NULL","D. WHERE ISNULL(manager_id)"],
    correctAnswer:"B",
    correctAnswerText:"✅ NULL cannot be compared with = (returns UNKNOWN, never TRUE). You MUST use IS NULL or IS NOT NULL. This is one of the most common SQL bugs.",
    expected:["IS NULL","NULL comparison"], hint:"NULL = NULL returns UNKNOWN, not TRUE." },

  { id:"sq7", role:"developer", track:"SQL", level:"Intermediate", type:"descriptive",
    title:"Window Functions vs GROUP BY",
    text:"Explain SQL window functions. How does ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) differ from GROUP BY dept?",
    expected:["window","OVER","PARTITION","ROW_NUMBER","GROUP BY"],
    correctAnswerText:"✅ GROUP BY collapses rows into one per group (loses individual row detail). Window functions keep all rows but add aggregate computation per row over a 'window'. ROW_NUMBER gives each employee a rank within their department without losing any employee rows.",
    hint:"Window functions add a column without reducing the number of rows — GROUP BY does reduce rows." },

  // ╔══════════ PYTHON ══════════╗
  { id:"py1", role:"developer", track:"Python", level:"Beginner", type:"mcq",
    title:"Mutable vs Immutable",
    text:"Which Python type is IMMUTABLE?",
    options:["A. list","B. dict","C. set","D. tuple"],
    correctAnswer:"D",
    correctAnswerText:"✅ Tuples are immutable — elements cannot be changed after creation. Lists, dicts, and sets are all mutable. Strings and frozensets are also immutable.",
    expected:["immutable","tuple"], hint:"Which one can't be modified after creation?" },

  { id:"py2", role:"developer", track:"Python", level:"Beginner", type:"mcq",
    title:"List Comprehension",
    text:"What does [x**2 for x in range(5) if x % 2 == 0] produce?",
    options:["A. [0, 4, 16]","B. [1, 4, 9, 16]","C. [0, 2, 4]","D. [0, 1, 4, 9, 16]"],
    correctAnswer:"A",
    correctAnswerText:"✅ range(5) is [0,1,2,3,4]. Filter x%2==0 gives [0,2,4]. Squaring gives [0,4,16]. List comprehension: [expression for item in iterable if condition].",
    expected:["comprehension","filter","range"], hint:"Apply the filter FIRST (only evens: 0,2,4), then square them." },

  { id:"py3", role:"developer", track:"Python", level:"Intermediate", type:"code",
    title:"Decorator with functools.wraps",
    code:"def timer(func):\n    # TODO: Complete this decorator\n    pass\n\n@timer\ndef slow_query(n):\n    \"\"\"Computes sum\"\"\"\n    return sum(range(n))",
    text:"Complete the timer decorator that logs execution time. Preserve the original function's __name__ and __doc__ using functools.wraps.",
    expected:["wrapper","time","functools","wraps"],
    correctAnswerText:"✅ import functools, time\ndef timer(func):\n    @functools.wraps(func)\n    def wrapper(*args, **kwargs):\n        start = time.perf_counter()\n        result = func(*args, **kwargs)\n        print(f'{func.__name__}: {time.perf_counter()-start:.4f}s')\n        return result\n    return wrapper\n\nWithout @functools.wraps, slow_query.__name__ would return 'wrapper'.",
    hint:"functools.wraps(func) copies __name__, __doc__, __annotations__ to the wrapper." },

  { id:"py4", role:"developer", track:"Python", level:"Intermediate", type:"mcq",
    title:"*args vs **kwargs",
    text:"def fn(*args, **kwargs): — which call is INVALID?",
    options:["A. fn(1, 2, name='x')","B. fn(*[1,2], **{'a':1})","C. fn(name='x', 1, 2)","D. fn()"],
    correctAnswer:"C",
    correctAnswerText:"✅ Positional arguments must come BEFORE keyword arguments. fn(name='x', 1, 2) is a SyntaxError. The interpreter can't determine where positionals end.",
    expected:["positional","keyword","SyntaxError"], hint:"Python rule: positionals before keyword arguments always." },

  { id:"py5", role:"developer", track:"Python", level:"Advanced", type:"code",
    title:"Context Manager __exit__",
    code:"class ManagedConnection:\n    def __init__(self, url):\n        self.url = url\n    # Add __enter__ and __exit__\n\nwith ManagedConnection('localhost') as conn:\n    conn.query('SELECT 1')",
    text:"Implement __enter__ and __exit__ so the connection closes safely even if an exception occurs inside the with block. What should __exit__ return to suppress exceptions?",
    expected:["__enter__","__exit__","exc_type","close","return False","return True"],
    correctAnswerText:"✅ def __enter__(self):\n    self.conn = connect(self.url)\n    return self.conn\n\ndef __exit__(self, exc_type, exc_val, exc_tb):\n    self.conn.close()\n    return False  # False = propagate exceptions, True = suppress them\n\nReturn True only if you intentionally want to swallow exceptions.",
    hint:"__exit__ receives (exc_type, exc_val, traceback). Return False to let exceptions propagate." },

  { id:"py6", role:"developer", track:"Python", level:"Intermediate", type:"mcq",
    title:"Generator Memory Advantage",
    text:"Processing a 10GB CSV file. Which approach is correct?",
    options:["A. data = list(open('file.csv')) — load all lines","B. data = [line for line in open('file.csv')] — list comp","C. for line in open('file.csv'): process(line) — iterate directly","D. data = open('file.csv').read().split('\\n') — split string"],
    correctAnswer:"C",
    correctAnswerText:"✅ Iterating directly (C) reads ONE line at a time using O(1) memory. Options A, B, D all load the entire 10GB file into RAM first. For large files, always use lazy iteration.",
    expected:["generator","lazy","memory","iterate"], hint:"Think about RAM consumption for a 10GB file." },

  // ╔══════════ WMS ══════════╗
  { id:"wms1", role:"functional", track:"WMS", level:"Beginner", type:"mcq",
    title:"LPN — License Plate Number",
    text:"What does LPN represent in Oracle WMS?",
    options:["A. Lot Processing Number — lot identifier","B. License Plate Number — unique container tracking ID","C. Location Primary Node — zone coordinator","D. Logistics Package Node — shipping manifest"],
    correctAnswer:"B",
    correctAnswerText:"✅ LPN (License Plate Number) is a unique container identifier. It travels with the physical container through receiving, putaway, picking, and shipping. LPNs can be nested (parent/child).",
    expected:["LPN","License Plate","container"], hint:"Think of LPN as the barcode on a warehouse tote or pallet." },

  { id:"wms2", role:"functional", track:"WMS", level:"Beginner", type:"mcq",
    title:"Putaway Rule Priority",
    text:"In Oracle WMS, what determines WHERE an item is putaway?",
    options:["A. The item category alone","B. The operating unit setting","C. Putaway Rules evaluated in sequence — first matching rule wins","D. Manual selection always required"],
    correctAnswer:"C",
    correctAnswerText:"✅ Putaway Rules are evaluated in sequence. Each rule specifies criteria (item, category, ABC class, zone). The FIRST matching rule determines the locator. If none match, the operation fails or falls to a default.",
    expected:["Putaway Rules","sequence","criteria","locator"], hint:"Rules are evaluated in priority order — first match wins." },

  { id:"wms3", role:"functional", track:"WMS", level:"Intermediate", type:"scenario",
    title:"Zero Pick Tasks Despite Inventory",
    text:"SCENARIO: Wave planning completed successfully for 80 orders. On-hand inventory is confirmed in the system. Pickers' scanners show zero tasks. The warehouse manager asks you to diagnose the root cause. Walk through your investigation steps.",
    expected:["allocation","rules","criteria","strategy","task dispatch","zone"],
    correctAnswerText:"✅ Investigation steps: 1) Check Wave Summary — did allocation actually succeed (not just planning)? 2) Review Allocation Rules — do the rules match the item/zone/lot attributes? 3) Check Task Dispatch Rules — are tasks being dispatched to the right equipment type/zone? 4) Check if inventory has a hold or non-nettable status. 5) Verify task type setup in the operation plan.",
    hint:"Wave 'Success' = planning ran. Allocation success is a separate step." },

  { id:"wms4", role:"functional", track:"WMS", level:"Intermediate", type:"mcq",
    title:"Cycle Count vs Physical Inventory",
    text:"What is the KEY operational difference?",
    options:["A. Physical counts one item; Cycle counts everything","B. Cycle count runs continuously on subset; Physical Inventory freezes entire warehouse","C. Physical auto-adjusts; Cycle Count needs approval","D. They are the same process with different UI"],
    correctAnswer:"B",
    correctAnswerText:"✅ Cycle Count = ongoing, subset of items, no freeze. Physical Inventory = full freeze, count all items simultaneously, warehouse operations halted. Cycle counting is less disruptive and catches errors more frequently.",
    expected:["continuous","freeze","subset","operations"], hint:"Which one requires shutting down the warehouse?" },

  { id:"wms5", role:"functional", track:"WMS", level:"Advanced", type:"scenario",
    title:"Replenishment Not Triggering",
    text:"SCENARIO: A replenishment rule is configured to refill pick faces from reserve when qty < 10. Reserve has 500+ units. No replenishment requests are generated even though pick locators are empty. List ALL setup checkpoints you would verify.",
    expected:["rule active","locator","threshold","trigger","min","replenishment type","item setup"],
    correctAnswerText:"✅ Checkpoints: 1) Is the rule status = Active? 2) Is the pick locator flagged for replenishment? 3) Is the locator's current count below min (it may not have hit threshold yet)? 4) Is the rule scoped to the correct subinventory/zone? 5) Is the item setup for picking from that locator? 6) Has the wave been run after the pick face went below threshold?",
    hint:"Replenishment only triggers AFTER the wave runs and detects shortage." },

  { id:"wms6", role:"functional", track:"WMS", level:"Intermediate", type:"scenario",
    title:"LPN Mislabeled at Receiving",
    text:"SCENARIO: A vendor shipped 50 units of Item-A but labeled the LPN as Item-B. The GR was scanned against the wrong item. Pick tasks are now being generated for Item-A from a locator containing Item-B. What is the corrective action flow?",
    expected:["correction","move order","adjustment","close","reopen","cancel","re-receive"],
    correctAnswerText:"✅ Corrective flow: 1) Cancel any open pick tasks for that locator. 2) Create a Miscellaneous Issue to remove the wrong item (Item-B) from the locator. 3) Create a Miscellaneous Receipt for the correct item (Item-A) to the locator. 4) Notify vendor for ASN correction. 5) Consider doing a physical count to verify adjustment. 6) Flag the PO receipt for AP reconciliation.",
    hint:"You cannot 'edit' a posted receipt — you must issue and re-receive to net correction." },

  { id:"wms7", role:"functional", track:"WMS", level:"Beginner", type:"mcq",
    title:"FEFO Picking Strategy",
    text:"What does FEFO mean in warehouse picking?",
    options:["A. First Entered First Out — oldest GR record","B. First Expired First Out — pick items expiring soonest first","C. First Empty First Out — empty locations first","D. Fastest Exit First Out — closest to dock first"],
    correctAnswer:"B",
    correctAnswerText:"✅ FEFO = First Expired, First Out. Items with the soonest expiry date are picked first to minimize waste. Critical for food, pharmaceutical, and perishable goods warehouses.",
    expected:["FEFO","expiry","first"], hint:"This strategy is common in pharmaceutical and food distribution." },

  { id:"wms8", role:"functional", track:"WMS", level:"Advanced", type:"scenario",
    title:"Cross-Docking Setup Issue",
    text:"SCENARIO: The operations team wants to set up cross-docking so inbound ASNs for Priority orders are automatically directed to outbound staging instead of putaway. After setup, all items still go to regular putaway. What could be misconfigured?",
    expected:["cross-dock","priority","rule","ASN","outbound","order type","staging"],
    correctAnswerText:"✅ Check: 1) Is the cross-dock rule active and in correct sequence? 2) Does the rule criteria match the priority order type? 3) Is the ASN linked to the outbound demand (order reservation)? 4) Is there available outbound demand (backordered orders) at time of receipt? 5) Is the putaway mode set to 'Cross-Dock First'? Without linked demand, even correct rules won't trigger cross-dock.",
    hint:"Cross-docking requires both an inbound receipt AND a qualifying outbound demand simultaneously." },

  // ╔══════════ SCM ══════════╗
  { id:"scm1", role:"functional", track:"SCM", level:"Beginner", type:"mcq",
    title:"P2P — After Goods Received",
    text:"In Procure-to-Pay, what step comes DIRECTLY AFTER goods are physically received?",
    options:["A. Create Requisition","B. Issue Purchase Order","C. Invoice Matching (3-way match)","D. Supplier Performance Review"],
    correctAnswer:"C",
    correctAnswerText:"✅ P2P sequence: Requisition → PO → Receipt → 3-way Invoice Match (PO qty + Receipt qty + Invoice amount) → Payment. The match step is critical — discrepancies trigger holds.",
    expected:["invoice","3-way","receipt"], hint:"Finance must verify the vendor bill against both PO and physical receipt." },

  { id:"scm2", role:"functional", track:"SCM", level:"Beginner", type:"mcq",
    title:"Blanket PO vs Standard PO",
    text:"When would you use a Blanket Purchase Agreement instead of a Standard PO?",
    options:["A. One-time purchase of a specific item","B. Recurring purchases from a supplier with pre-agreed pricing over a period","C. Emergency procurement without approval","D. Purchase from a new unapproved supplier"],
    correctAnswer:"B",
    correctAnswerText:"✅ Blanket PO = pre-agreed price/terms for multiple releases over a period (e.g., annual stationery contract). Standard PO = single, specific purchase event. Blanket POs reduce overhead for frequent recurring purchases.",
    expected:["blanket","recurring","period","releases"], hint:"Think: one purchase vs many purchases from the same agreement." },

  { id:"scm3", role:"functional", track:"SCM", level:"Intermediate", type:"scenario",
    title:"PO Stuck in Receiving — Cannot Close",
    text:"SCENARIO: A Purchase Order for 100 units was approved. The warehouse received 95 units. The PO shows 'Open' and cannot be closed. Finance is asking why the PO hasn't closed. Diagnose the possible causes.",
    expected:["tolerance","over-receipt","receipt close tolerance","approval","remaining","cancel"],
    correctAnswerText:"✅ Possible causes: 1) Receipt Close Tolerance not set — PO requires 100% receipt unless tolerance allows closure below 100%. 2) Outstanding uninvoiced receipts. 3) An open return-to-supplier is pending. 4) The remaining 5 units are still expected (backordered). Fix: Set receipt close tolerance (e.g., 5%) in PO Setup, or manually cancel the remaining PO lines.",
    hint:"Oracle PO has a 'Receipt Close Tolerance' percentage that allows closure below 100%." },

  { id:"scm4", role:"functional", track:"SCM", level:"Intermediate", type:"mcq",
    title:"Drop Shipment Flow",
    text:"In Oracle SCM Drop Shipment, who physically ships goods to the end customer?",
    options:["A. Internal warehouse staff","B. A 3PL logistics provider","C. The supplier ships directly — bypassing your warehouse","D. The customer picks up from supplier"],
    correctAnswer:"C",
    correctAnswerText:"✅ Drop Ship: Supplier ships DIRECTLY to customer. Oracle creates a PO to supplier automatically when SO is approved. No internal warehouse movement occurs. Receipt is 'logical' only, triggered by Advance Shipment Notice.",
    expected:["supplier","directly","PO","logical receipt"], hint:"The key is 'bypassing' the internal warehouse." },

  { id:"scm5", role:"functional", track:"SCM", level:"Intermediate", type:"scenario",
    title:"ASN Discrepancy at Receiving",
    text:"SCENARIO: An ASN from the supplier shows 200 units of Item X. When receiving against the ASN, Oracle shows a discrepancy — only 180 units match against the PO. The remaining 20 have no PO backing. What are the steps to investigate and resolve?",
    expected:["ASN","PO","discrepancy","over-receipt","return","amendment","tolerance"],
    correctAnswerText:"✅ Steps: 1) Verify ASN line quantities against PO line quantities. 2) Check if additional PO lines were accidentally omitted. 3) Verify if supplier shipped extra units not on PO (over-shipment). 4) Contact supplier to clarify: was this substitution, extra units, or error? 5) If extra units accepted: create PO amendment for additional qty. 6) If rejected: arrange return to supplier (RTS). Always reconcile ASN to PO before completing receipt.",
    hint:"You may need to amend the PO to accommodate the over-shipped quantity legally." },

  { id:"scm6", role:"functional", track:"SCM", level:"Advanced", type:"scenario",
    title:"Invoice on Hold — Resolving 3-Way Match Failure",
    text:"SCENARIO: A supplier invoice for $52,000 is on hold. The PO was for 1000 units at $50/unit ($50,000). The receipt was for 1000 units. The invoice is for 1000 units at $52/unit. What type of hold is this and how do you resolve it?",
    expected:["price hold","variance","tolerance","override","amendment","credit memo"],
    correctAnswerText:"✅ This is a PRICE VARIANCE hold. Invoice price ($52) ≠ PO price ($50) = $2000 variance. Resolution options: 1) If price increase was agreed: amend PO price and release hold. 2) If unauthorized: reject invoice, request $50 price credit memo from supplier. 3) Set price tolerance in AP Setup (e.g., allow 2% variance = $1/unit would auto-pass). Never approve an invoice hold without understanding the cause.",
    hint:"3-way match compares PO price, receipt qty, and invoice amount. A variance on any dimension creates a hold." },

  { id:"scm7", role:"functional", track:"SCM", level:"Beginner", type:"mcq",
    title:"Back-to-Back Order",
    text:"In Oracle SCM, what is a 'Back-to-Back' order flow?",
    options:["A. Return order followed by a new order from same customer","B. Supply is created (PO/WO) directly driven by a specific customer Sales Order","C. Two SOs linked to same PO","D. Emergency procurement outside normal process"],
    correctAnswer:"B",
    correctAnswerText:"✅ Back-to-Back: A customer SO automatically triggers creation of a Supply (PO or Work Order). The supply is for that specific customer — not general stock replenishment. It links demand to supply 1:1.",
    expected:["back-to-back","SO","supply","PO"], hint:"Think demand → supply, directly linked, not going through general inventory." },

  // ╔══════════ HCM ══════════╗
  { id:"hcm1", role:"functional", track:"HCM", level:"Beginner", type:"mcq",
    title:"Worker vs Employee in Oracle",
    text:"In Oracle HCM, what is the relationship between 'Worker' and 'Employee'?",
    options:["A. Identical terms","B. Worker is the person record; Employee is the work relationship type","C. Employees are permanent; Workers are contractors","D. Worker is a grade; Employee is a job"],
    correctAnswer:"B",
    correctAnswerText:"✅ Worker = the person entity (can have multiple employment records). Employee is one type of Work Relationship. A worker can also be a Contingent Worker or Pending Worker. The person record (Worker) persists even after employment ends.",
    expected:["Worker","person","work relationship"], hint:"Worker is the parent — Employee is a type of relationship attached to that parent." },

  { id:"hcm2", role:"functional", track:"HCM", level:"Beginner", type:"mcq",
    title:"Position vs Job",
    text:"In Oracle HCM, what is the difference between a Position and a Job?",
    options:["A. They are synonymous","B. Job is the generic role; Position is a specific instance of a job in an org unit with a headcount","C. Position is global; Job is country-specific","D. Job belongs to a grade; Position belongs to a salary"],
    correctAnswer:"B",
    correctAnswerText:"✅ Job = generic role definition (e.g., 'Software Engineer'). Position = specific headcount slot in a specific org (e.g., 'Software Engineer — WMS Team — India'). Positions have headcount limits. An employee is assigned to a Position, which has a Job.",
    expected:["Job","Position","headcount","org"], hint:"Many employees can have 'Software Engineer' as a Job, but each Position is unique." },

  { id:"hcm3", role:"functional", track:"HCM", level:"Intermediate", type:"scenario",
    title:"Payslip Element Missing",
    text:"SCENARIO: An employee's approved Overtime element shows as an Element Entry in HCM, but the Overtime amount is completely absent from the payslip. The payroll run was completed successfully. What are the most likely causes to investigate?",
    expected:["non-recurring","processed","effective date","status","input value","element link"],
    correctAnswerText:"✅ Investigation: 1) Is the element 'Non-Recurring'? If so, it processes once and then closes — was it already consumed in a prior payroll run without being re-entered? 2) Is the element entry's effective date within the payroll period? 3) Is the element link active for this employee's assignment? 4) Did the payroll process pick up this assignment? 5) Check the calculation log for that employee — was the element formula evaluated?",
    hint:"Non-recurring = processes once. Check if the entry was already 'processed' in a previous run." },

  { id:"hcm4", role:"functional", track:"HCM", level:"Intermediate", type:"mcq",
    title:"Absence Approval Trigger",
    text:"What DETERMINES whether an employee's absence request requires manager approval?",
    options:["A. Employee's grade level","B. The Absence Type configuration and attached workflow","C. The HR Business Partner assignment","D. Absence duration > 3 days automatically"],
    correctAnswer:"B",
    correctAnswerText:"✅ Absence Type configuration controls workflow. Each Absence Type can have: no approval needed, line manager approval, or multi-level approval. This is configured in the Absence Type definition, not by employee grade or duration.",
    expected:["Absence Type","workflow","configuration"], hint:"It's set on the Absence Type record, not on the individual employee." },

  { id:"hcm5", role:"functional", track:"HCM", level:"Intermediate", type:"scenario",
    title:"Hire Process — Missing Grade Step",
    text:"SCENARIO: A new employee was hired successfully and appears in the system. However, their compensation grade step is not showing in their assignment. The grade is correct. What could be missing in the hire process?",
    expected:["grade step","grade ladder","progression","assignment","element entry","compensation"],
    correctAnswerText:"✅ Possible causes: 1) Grade Ladder not attached to the grade — step progression won't appear without a ladder. 2) Grade Step not defined within the grade ladder for this grade. 3) Assignment Grade Step manually not selected during hire. 4) Compensation Element Entry not created via Manage Compensation. 5) Check if automatic Progression Rules are configured to assign steps at hire.",
    hint:"Grade Steps only appear when a Grade Ladder is configured and linked to the Grade." },

  { id:"hcm6", role:"functional", track:"HCM", level:"Advanced", type:"scenario",
    title:"Legal Entity vs Business Unit",
    text:"SCENARIO: An employee is being set up in HCM but the payroll team cannot assign them to a payroll. The HR team says the legal entity is correct. What additional organizational structure check is needed?",
    expected:["business unit","legal entity","payroll","legislative data group","LDG","assignment"],
    correctAnswerText:"✅ Payroll in Oracle HCM is tied to the Legislative Data Group (LDG) which is linked to the Legal Entity. Check: 1) Does the employee's assignment have a Legal Entity with a matching LDG? 2) Is a Payroll created under that LDG? 3) Does the employee's Business Unit have a mapping to this Legal Entity? Without these links, the payroll won't appear as available for assignment.",
    hint:"Each Payroll belongs to an LDG, not directly to a Business Unit." },

  // ╔══════════ FIXED ASSETS ══════════╗
  { id:"fa1", role:"functional", track:"Fixed Assets", level:"Beginner", type:"mcq",
    title:"Mass Additions Source",
    text:"Which Oracle module typically generates Mass Additions into Fixed Assets?",
    options:["A. Oracle AR (Receivables)","B. Oracle GL (General Ledger)","C. Oracle AP — capitalizable invoice lines","D. Oracle Inventory directly"],
    correctAnswer:"C",
    correctAnswerText:"✅ Oracle Payables creates Mass Addition records from invoice lines flagged as 'Capitalize'. These appear in Oracle Assets as 'Post' status lines awaiting review. The AP-to-FA integration runs via the Transfer Mass Additions process.",
    expected:["AP","Payables","Mass Additions","capitalize"], hint:"The accounts payable invoice triggers the asset creation pipeline." },

  { id:"fa2", role:"functional", track:"Fixed Assets", level:"Beginner", type:"mcq",
    title:"Straight-Line Depreciation",
    text:"Asset costs $24,000. Useful life 4 years. No salvage value. STL method. Monthly depreciation is:",
    options:["A. $6,000/month","B. $500/month","C. $2,000/month","D. $1,000/month"],
    correctAnswer:"B",
    correctAnswerText:"✅ STL monthly = Cost / (Years × 12) = $24,000 / 48 = $500/month. Annual = $6,000. Total over 4 years = $24,000 (fully depreciated).",
    expected:["STL","$500","48 months","straight-line"], hint:"Monthly = Cost ÷ (Life in years × 12)." },

  { id:"fa3", role:"functional", track:"Fixed Assets", level:"Intermediate", type:"scenario",
    title:"Zero Depreciation — Following Month Convention",
    text:"SCENARIO: 200 scanners worth $500,000 were added to Fixed Assets on March 15th. The March depreciation run shows $0.00 for ALL of these assets. The Asset Book uses 'Following Month' prorate convention. Is this expected behavior or a setup error? Explain.",
    expected:["Following Month","prorate","next period","convention"],
    correctAnswerText:"✅ This is EXPECTED. 'Following Month' prorate convention means: assets placed in service this month begin depreciating in the NEXT month. So scanners added in March will show $0 in March and start depreciating in April. To verify: check the Asset Book → Prorate Convention setup. If first-month depreciation is required, change to 'Actual Days' or 'Half Year' convention.",
    hint:"'Following Month' = no depreciation in the month of addition. Depreciation starts next month." },

  { id:"fa4", role:"functional", track:"Fixed Assets", level:"Intermediate", type:"mcq",
    title:"Partial Retirement",
    text:"When you PARTIALLY retire an asset in Oracle Fixed Assets, what happens to the remaining units?",
    options:["A. Entire asset is retired","B. Remaining units continue depreciating as an adjusted active asset","C. Oracle rejects partial — must retire all or none","D. Depreciation suspends pending management approval"],
    correctAnswer:"B",
    correctAnswerText:"✅ Partial retirement removes the specified unit quantity and its proportional cost/accumulated depreciation. The remaining units continue as an active asset with adjusted Net Book Value. Oracle supports group asset partial retirement.",
    expected:["partial","NBV","remaining","units"], hint:"Oracle handles partial retirement by adjusting cost and accumulated depreciation proportionally." },

  { id:"fa5", role:"functional", track:"Fixed Assets", level:"Advanced", type:"scenario",
    title:"Revaluation vs GL Discrepancy",
    text:"SCENARIO: 500 machines revalued +15% in Oracle Assets. The Assets module shows the new revalued cost. However, the GL Asset cost account balance does NOT match the Oracle FA balance. The revaluation ran without errors. What are your reconciliation steps?",
    expected:["journal","GL","period","revaluation reserve","cost account","reconcile"],
    correctAnswerText:"✅ Reconciliation steps: 1) Run the FA-to-GL reconciliation report for that period. 2) Verify Revaluation journal entries were POSTED (not just created) to GL. 3) Check if journals posted to the correct accounting period (not a closed or future period). 4) Verify the correct asset cost account in the Asset Category setup. 5) Check if any manual GL journals were posted to the asset account incorrectly. 6) Confirm the revaluation reserve account captured the offset entry.",
    hint:"Revaluation creates two entries: debit asset cost account + credit revaluation reserve. Both must post." },

  { id:"fa6", role:"functional", track:"Fixed Assets", level:"Intermediate", type:"scenario",
    title:"CIP Asset — When to Capitalize",
    text:"SCENARIO: The construction team has been tracking a building project as a CIP (Construction in Progress) asset for 14 months. The building is now complete and in use. Finance asks you to explain what must happen now and what journal entries are generated.",
    expected:["CIP","capitalize","transfer","placed in service","depreciation start","journal"],
    correctAnswerText:"✅ Process: 1) Reclassify CIP to a depreciable asset — 'Place in Service' the asset. 2) In Oracle Assets: transfer from CIP asset book to regular Asset Book with the in-service date. 3) Assign correct Asset Category and depreciation method. 4) GL entries: Debit Asset Category cost account, Credit CIP account. 5) Depreciation now begins based on in-service date and prorate convention. CIP assets NEVER depreciate — they accumulate cost until capitalized.",
    hint:"CIP = accumulation phase. Placed in Service = depreciation begins. The transition is a reclassification journal." },

  { id:"fa7", role:"functional", track:"Fixed Assets", level:"Beginner", type:"mcq",
    title:"Asset Category Purpose",
    text:"What is the primary purpose of an Asset Category in Oracle Fixed Assets?",
    options:["A. Groups assets for physical counting","B. Defines default depreciation method, life, and GL accounts for assets","C. Controls who can add assets","D. Determines the revaluation schedule"],
    correctAnswer:"B",
    correctAnswerText:"✅ Asset Category provides defaults: depreciation method (STL/DB), useful life, salvage value %, and the GL account codes (cost, accumulated depreciation, depreciation expense). Without a category, you cannot add assets.",
    expected:["category","defaults","GL accounts","depreciation method"], hint:"Category = template that pre-fills depreciation setup and accounting codes." }
];

// ════════════════════════════════════════════════════════════
//   EXPANDED KNOWLEDGE BASE (Training Agent)
// ════════════════════════════════════════════════════════════

const KB = {
  // ── Java
  "hashmap":          { title:"HashMap & Collections", explanation:"HashMap: ONE null key, unlimited null values, O(1) avg. NOT ordered (LinkedHashMap for order), NOT thread-safe (ConcurrentHashMap for threads). Internal: array of linked lists/trees at collision.", example:"Map<String,Integer> m = new HashMap<>();\nm.put(null, 0);  // OK — one null key\nm.put(\"a\", null); // OK\nm.getOrDefault(\"x\", -1); // returns -1", followUp:"How does HashMap resize and what is the load factor?" },
  "optional":         { title:"Optional<T> — Null Safety", explanation:"Optional is a container that may or may not hold a value. Use it to signal nullability in APIs. Never use Optional.get() without isPresent() check.", example:"Optional.ofNullable(user.getEmail())\n  .filter(e -> e.contains('@'))\n  .map(String::toLowerCase)\n  .orElse('no-reply@example.com');", followUp:"When should you NOT use Optional (e.g., as a field type)?" },
  "streams":          { title:"Java Stream API", explanation:"Streams process collections lazily. Intermediate ops: filter(), map(), sorted(), distinct(), flatMap(). Terminal ops: collect(), count(), reduce(), forEach(), findFirst(). Parallel: .parallelStream().", example:"List<String> result = employees.stream()\n  .filter(e -> e.isActive())\n  .map(Employee::getName)\n  .sorted()\n  .distinct()\n  .collect(Collectors.toList());", followUp:"What is the difference between map() and flatMap()?" },
  "threading":        { title:"Java Concurrency & Locks", explanation:"synchronized uses intrinsic lock (monitor). ReentrantLock gives: tryLock() with timeout, lockInterruptibly(), fairness. ExecutorService manages thread pools. volatile ensures visibility (not atomicity).", example:"ExecutorService pool = Executors.newFixedThreadPool(4);\nFuture<Integer> f = pool.submit(() -> expensiveCalc());\nint result = f.get(5, TimeUnit.SECONDS); // timeout", followUp:"What is the difference between volatile and synchronized?" },
  "garbage collection":{ title:"Java Garbage Collection", explanation:"JVM GC reclaims unreachable objects. Generations: Young (Eden + Survivor), Old (Tenured), Metaspace. Minor GC = Young gen. Major/Full GC = Old gen (expensive, stop-the-world). G1GC is default in modern JVMs.", example:"// Force GC hint (not guaranteed):\nSystem.gc();\n// Better: profile with JVisualVM or async-profiler", followUp:"What causes frequent Full GC and how do you diagnose it?" },
  "equals hashcode":  { title:"equals() and hashCode() Contract", explanation:"If a.equals(b) is true, then a.hashCode() == b.hashCode() MUST be true. Override both together. Used by HashMap/HashSet for bucket placement and equality check.", example:"@Override public boolean equals(Object o) {\n  if (this == o) return true;\n  if (!(o instanceof Employee)) return false;\n  return this.id.equals(((Employee)o).id);\n}\n@Override public int hashCode() { return id.hashCode(); }", followUp:"What happens if you override equals() but NOT hashCode()?" },
  // ── JavaScript
  "closure":          { title:"JavaScript Closures", explanation:"A closure gives a function access to its outer scope's variables even after that scope has exited. Used for data privacy, factory functions, memoization.", example:"function makeCounter(start = 0) {\n  let count = start;\n  return {\n    inc: () => ++count,\n    get: () => count,\n    reset: () => { count = start; }\n  };\n}\nconst c = makeCounter(10);\nc.inc(); // 11", followUp:"How can closures cause memory leaks in JavaScript?" },
  "promise":          { title:"Promises & async/await", explanation:"Promise states: pending → fulfilled | rejected. Promise.all() = fail-fast (one rejection = all fail). Promise.allSettled() = waits for all, returns status array. async/await is syntax sugar over Promises.", example:"const [orders, inventory] = await Promise.allSettled([\n  fetchOrders(),\n  fetchInventory()\n]);\nif (orders.status === 'fulfilled') process(orders.value);", followUp:"What happens to unhandled Promise rejections in Node.js?" },
  "event loop":       { title:"JavaScript Event Loop", explanation:"Order: Synchronous code → Microtasks (Promise .then, queueMicrotask) → Macrotasks (setTimeout, setInterval, I/O). Microtasks always run before macrotasks, even at delay=0.", example:"console.log('1');                    // sync\nPromise.resolve().then(()=>console.log('2')); // microtask\nsetTimeout(()=>console.log('3'),0);   // macrotask\nconsole.log('4');           // output: 1, 4, 2, 3", followUp:"Why do Promises execute before setTimeout even with 0ms delay?" },
  "react hooks":      { title:"React Hooks", explanation:"useState = component state. useEffect = side effects (lifecycle). useCallback = memoize function reference (prevents children re-render). useMemo = memoize expensive computation. useRef = DOM reference without re-render.", example:"const [data, setData] = useState(null);\nuseEffect(() => {\n  const controller = new AbortController();\n  fetchData(controller.signal).then(setData);\n  return () => controller.abort(); // cleanup\n}, [url]); // re-runs when url changes", followUp:"When would useCallback actually cause a performance regression?" },
  "prototype":        { title:"JavaScript Prototype Chain", explanation:"Every object has [[Prototype]]. Property lookup: own → prototype → Object.prototype → null. class is syntactic sugar over prototype chain. Object.create(proto) creates object with specified prototype.", example:"class Animal { speak() { return 'sound'; } }\nclass Dog extends Animal { speak() { return 'woof'; } }\n// Dog.prototype.__proto__ === Animal.prototype // true", followUp:"What is the difference between __proto__ and Object.getPrototypeOf()?" },
  // ── SQL/Oracle
  "index":            { title:"SQL Indexes & Sargability", explanation:"Sargable: WHERE col = value (uses index). Non-sargable: WHERE UPPER(col) = 'X' (breaks index). B-tree index: equality and range. Bitmap index: low-cardinality columns. Function-based index: index on expression.", example:"-- Sargable (uses index):\nSELECT * FROM users WHERE email = 'a@b.com';\n\n-- Non-sargable (full scan):\nSELECT * FROM users WHERE UPPER(email) = 'A@B.COM';\n\n-- Fix: create function-based index:\nCREATE INDEX idx ON users(UPPER(email));", followUp:"When should you NOT create an index on a column?" },
  "joins":            { title:"SQL JOIN Types", explanation:"INNER = only matching rows. LEFT = all left + matched right (NULL if no right match). RIGHT = inverse of LEFT. FULL OUTER = all rows both sides. CROSS = cartesian product (M×N rows). Self JOIN = table joined to itself.", example:"-- Get all employees and their manager (self join)\nSELECT e.name, m.name AS manager\nFROM employees e\nLEFT JOIN employees m ON e.manager_id = m.id;", followUp:"What is the difference between WHERE and ON clause in a JOIN?" },
  "transactions":     { title:"SQL Transactions & Isolation", explanation:"ACID: Atomic, Consistent, Isolated, Durable. Isolation levels: READ COMMITTED (default Oracle), REPEATABLE READ, SERIALIZABLE. SELECT FOR UPDATE locks rows. Deadlock = two transactions each holding a lock the other needs.", example:"BEGIN;\nSELECT * FROM tasks\nWHERE status = 'PENDING'\nFOR UPDATE SKIP LOCKED\nLIMIT 1;\n-- Process task\nUPDATE tasks SET status = 'DONE' WHERE id = ?;\nCOMMIT;", followUp:"What is a deadlock and how do you detect and prevent it?" },
  "window functions": { title:"SQL Window Functions", explanation:"Window functions compute aggregate values per row over a 'window' of rows WITHOUT collapsing rows (unlike GROUP BY). Key: ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD, SUM OVER, AVG OVER.", example:"SELECT emp_id, salary, dept,\n  RANK() OVER (PARTITION BY dept ORDER BY salary DESC) AS dept_rank,\n  SUM(salary) OVER (PARTITION BY dept) AS dept_total\nFROM employees;", followUp:"What is the difference between RANK() and DENSE_RANK()?" },
  // ── Python
  "generator":        { title:"Python Generators", explanation:"Generators use 'yield' to return values lazily one at a time. Use O(1) memory regardless of dataset size. Perfect for large files, streaming, infinite sequences. Generator expressions: (x for x in range(n)).", example:"def read_large_file(path):\n    with open(path) as f:\n        for line in f:\n            yield line.strip()\n\n# Processes 10GB file with minimal RAM\nfor record in read_large_file('huge.csv'):\n    process(record)", followUp:"What is the difference between yield and return in Python?" },
  "decorator":        { title:"Python Decorators", explanation:"Decorator = a function that wraps another function to add behavior. Uses: logging, timing, auth, retry logic, caching. @functools.wraps preserves wrapped function's metadata (__name__, __doc__).", example:"import functools, time\ndef retry(max_attempts=3):\n    def decorator(func):\n        @functools.wraps(func)\n        def wrapper(*args, **kwargs):\n            for i in range(max_attempts):\n                try: return func(*args, **kwargs)\n                except Exception: \n                    if i == max_attempts-1: raise\n        return wrapper\n    return decorator", followUp:"How do you create a parameterized decorator (decorator factory)?" },
  "context manager":  { title:"Python Context Managers", explanation:"with statement guarantees __exit__ runs even if exception occurs. Implement via class (__enter__/__exit__) or @contextmanager decorator. __exit__(exc_type, exc_val, tb) — return True to suppress, False to propagate.", example:"from contextlib import contextmanager\n@contextmanager\ndef db_connection(url):\n    conn = connect(url)\n    try:\n        yield conn\n    finally:\n        conn.close()  # always runs\n\nwith db_connection('localhost') as conn:\n    conn.query('SELECT 1')", followUp:"When would you want __exit__ to return True and suppress exceptions?" },
  "list comprehension":{ title:"Python List & Dict Comprehensions", explanation:"Compact way to create sequences. [expr for x in iter if cond]. Dict: {k:v for k,v in items}. Set: {expr for x in iter}. Often faster than equivalent for-loops due to CPython optimization.", example:"# List: squares of even numbers\nsquares = [x**2 for x in range(20) if x % 2 == 0]\n\n# Dict: {name: salary} for active staff\nstaff = {e.name: e.salary for e in employees if e.active}", followUp:"When should you use a generator expression instead of a list comprehension?" },
  // ── WMS
  "lpn":              { title:"LPN — License Plate Number", explanation:"LPN is a unique container ID in Oracle WMS. Tracks a group of items through receiving, putaway, picking, shipping. LPNs are nested (parent container holds child LPNs). Context: Resides In WMS, Pre-generated, Issued to WMS, Loaded.", example:"Receive → Generate LPN → Scan LPN to Locator\nPick → Scan LPN → Decant to Outbound LPN → Pack → Ship", followUp:"What is the difference between LPN Context and LPN Status?" },
  "wave planning":    { title:"WMS Wave Planning & Allocation", explanation:"Wave = grouping of orders for fulfillment. Steps: Plan Wave → Allocate Inventory → Generate Tasks → Dispatch to Device. Allocation Rules determine which inventory maps to which order (FEFO, zone, lot, unit of measure).", example:"Order criteria → Wave Plan → Check Allocation Rules\n→ Reserve Inventory → Create Pick Tasks → Dispatch", followUp:"Why would wave planning show 'Success' but produce zero pick tasks?" },
  "cycle count":      { title:"WMS Cycle Counting", explanation:"Continuous counting of rotating item subsets. No warehouse freeze. Discrepancies above threshold require approval before adjustment. ABC classification drives count frequency (A items: weekly, B: monthly, C: quarterly).", example:"Setup Cycle Count → Assign Items/Locators\n→ System prints count sheets → Counter scans\n→ Compare to system → Variance > threshold = approval\n→ Approved = adjust on-hand", followUp:"How does ABC classification affect cycle count frequency?" },
  "replenishment":    { title:"WMS Replenishment Process", explanation:"Replenishment refills pick faces from reserve. Triggered when pick locator qty falls below minimum. Types: Min-Max, PO-based, WIP demand. Rules define source subinventory, destination locator, and trigger threshold.", example:"Pick face qty drops below min → Wave run detected shortage\n→ Replenishment Rule matched → Request created\n→ Forklift picks from Reserve → Delivers to Pick Face", followUp:"Why might replenishment not trigger even when pick face is empty?" },
  "fefo":             { title:"FEFO — First Expired First Out", explanation:"Lot-controlled items picked by soonest expiry first. Requires Lot control, Shelf Life tracking, and FEFO picking strategy on Allocation Rules. Prevents expired goods from shipping.", example:"Lot A: expires 2025-06-01\nLot B: expires 2025-09-01\nFEFO picks Lot A first → maximizes shelf life at customer", followUp:"How does FEFO interact with lot-controlled putaway rules?" },
  // ── SCM
  "p2p":              { title:"Procure-to-Pay (P2P) Cycle", explanation:"Full P2P: Requisition → Approval → PO → Supplier Acknowledgment → Goods Receipt (ASN) → Quality inspection → Receipt confirmation → AP Invoice → 3-way Match → Payment. Holds block payment at matching step.", example:"PR → PO → GR → Invoice → Match → Clear Hold → Pay", followUp:"What are the three elements of a 3-way match?" },
  "drop shipment":    { title:"Drop Shipment Flow (SCM)", explanation:"SO approved → DOO creates PO to supplier automatically → Supplier ships to customer → ASN received → Logical receipt in Oracle (no physical receipt) → Invoice → Payment. No warehouse movement.", example:"Customer SO → DOO → Auto-generate Supplier PO\n→ Supplier dispatches → ASN → Logical Receipt\n→ Backdated inventory transaction → Invoice", followUp:"How does a customer return (RMA) work for a drop-shipped order?" },
  "blanket po":       { title:"Blanket Purchase Agreement", explanation:"Pre-negotiated price/terms for multiple releases from one supplier over a period. Releases are created as needed from the BPA. Helps with recurring spend without re-negotiating each time.", example:"Annual stationery BPA with Supplier X:\n- Agreed: 5000 reams @ $4/ream\n- Release 1: Jan — 500 reams\n- Release 2: Mar — 300 reams\n(No new negotiation per release)", followUp:"What is the difference between a BPA release and a standard PO?" },
  "3-way match":      { title:"3-Way Invoice Matching", explanation:"3-way match compares: PO (price, qty) + Receipt (qty) + Invoice (price, qty). All three must agree within tolerance. Discrepancy = hold. Types: Price Variance Hold, Quantity Hold, Receipt Hold.", example:"PO: 100 units @ $10 = $1,000\nReceipt: 100 units confirmed\nInvoice: 100 units @ $12 = $1,200 → PRICE HOLD\nResolution: PO amendment or reject invoice", followUp:"What is a 2-way match and when is it used instead of 3-way?" },
  // ── HCM
  "payroll":          { title:"Oracle HCM Payroll Cycle", explanation:"Sequence: Calculate → Verify → Balance Reconciliation → Prepayment → Costing → Archive → Transfer → Close. Recurring elements: every run. Non-recurring: once only. FastFormula drives element calculations.", example:"Element Entry → Payroll Run → Calculate → Payslip\n→ BACS file → Bank transfer → Close Period", followUp:"What is a FastFormula in Oracle HCM payroll?" },
  "absence":          { title:"HCM Absence Management", explanation:"Absence Type defines: approval workflow, accrual plan, validity period, accrual formula, and absence category. Employee submits → workflow → approved → balance deducted → payroll informed.", example:"Policy: 20 days annual leave\nEmployee submits 5 days → Manager approves\n→ Balance: 20 - 5 = 15 days remaining\n→ Payroll period: no deduction for paid leave", followUp:"What is the difference between accrual and entitlement absence plans?" },
  "grade step":       { title:"HCM Grade & Grade Step", explanation:"Grade: broad pay band. Grade Step: specific point within that band (e.g., Step 3 within Grade C). Grade Ladder links grades to progression rules. Step progression can be automatic (time-in-step) or manual.", example:"Grade C: Step 1 ($50K), Step 2 ($55K), Step 3 ($60K)\nEmployee joins at Step 1 → 1 year later → auto-promote to Step 2", followUp:"What triggers an automatic grade step progression in Oracle HCM?" },
  // ── Fixed Assets
  "depreciation":     { title:"Fixed Asset Depreciation", explanation:"Methods: STL (even monthly), Declining Balance (front-loaded), Sum-of-Years-Digits, Units of Production. Prorate Conventions: Following Month (0 first month), Actual Days, Half-Year. Each Asset Category has a default method.", example:"$12,000 asset, 4yr STL, Following Month\nMonthly = 12000/48 = $250/month\nJan addition → $0 Jan → $250 Feb onwards", followUp:"What is the difference between Declining Balance and STL depreciation?" },
  "mass additions":   { title:"Oracle FA Mass Additions", explanation:"AP creates Mass Additions from capitalizable invoice lines. In FA: Post Mass Additions process creates active assets. Statuses: New → Post → Merged → Deleted. Manually review and classify before posting.", example:"AP Invoice → Line flagged Capitalize\n→ Run FA Mass Addition Transfer\n→ FA Post Mass Additions screen\n→ Review → Post → Active Asset created", followUp:"What information on an AP line determines if it generates a Mass Addition?" },
  "cip":              { title:"CIP — Construction in Progress", explanation:"CIP assets accumulate costs during construction. They do NOT depreciate. When construction completes, the CIP is reclassified (Place in Service) to a depreciable asset category. GL: Debit Asset, Credit CIP.", example:"Jan-Dec: Monthly construction costs → CIP account\nProject complete → Place in Service\n→ GL: Dr Asset Account, Cr CIP\n→ Depreciation begins next period", followUp:"How do you track multiple projects using separate CIP asset lines?" },
  "asset retirement": { title:"Asset Retirement Process", explanation:"Full retirement: remove all NBV. Partial retirement: by units. Retirement creates: debit Accumulated Depreciation, debit Loss on Disposal (if NBV > proceeds), credit Asset Cost, credit Gain (if proceeds > NBV).", example:"Asset: Cost $10K, Accum Depr $6K, NBV $4K\nSold for $5K:\nDebit AccumDepr $6K + Credit Asset $10K\n+ Credit Gain on Sale $1K", followUp:"What is the difference between an Asset Retirement and an Asset Transfer?" }
};

// ════════════════════════════════════════════════════════════
//   DOCUMENT KNOWLEDGE BASE
//   Populated from user-uploaded files (Java, Spring, SQL, etc.)
//   Format: { topic, question, answer, tags[] }
// ════════════════════════════════════════════════════════════

import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let DOCUMENT_KB = [];
try {
  const docPath = path.join(__dirname, 'knowledge', 'document_kb.json');
  const docContent = fs.readFileSync(docPath, 'utf8');
  DOCUMENT_KB = JSON.parse(docContent);
  console.log(`Loaded ${DOCUMENT_KB.length} document questions.`);
} catch(e) {
  console.warn("Could not load knowledge/document_kb.json — starting with empty document KB.", e.message);
}

function searchDocumentKB(query) {
  if (DOCUMENT_KB.length === 0) return null;
  const q = query.toLowerCase();
  // Score each doc entry by keyword overlap
  let best = null; let bestScore = 0;
  for (const entry of DOCUMENT_KB) {
    const text = `${entry.topic} ${entry.question} ${(entry.tags||[]).join(" ")}`;
    const words = q.split(/\s+/).filter(w => w.length > 3);
    const score = words.reduce((s, w) => text.toLowerCase().includes(w) ? s + 1 : s, 0);
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return bestScore >= 2 ? best : null;  // require at least 2 keyword matches
}

// ════════════════════════════════════════════════════════════
//   AGENT RESPONSE ENGINE  (3-tier: DocumentKB → Built-in KB → Domain fallback)
// ════════════════════════════════════════════════════════════

// Full domain knowledge for fallback (covers common questions not in KB)
const DOMAIN_KNOWLEDGE = {
  java: {
    topics: ["OOP","Collections","Multithreading","JVM","Spring Boot","Design Patterns","Streams","Exception Handling"],
    quickAnswers: {
      "oops":"Java OOP Pillars: 1) Encapsulation — hide data via private fields + getters/setters. 2) Inheritance — extends keyword, IS-A relationship. 3) Polymorphism — method overriding (runtime) + overloading (compile-time). 4) Abstraction — abstract classes + interfaces hide implementation.",
      "interface":"Interface vs Abstract Class: Interface = pure contract (all methods abstract by default, Java 8+ allows default methods). Abstract Class = partial implementation. Use interface for 'CAN-DO' (Flyable, Serializable). Use abstract for 'IS-A' with shared code.",
      "spring":"Spring Boot core: Auto-configuration (spring-boot-autoconfigure scans classpath), Component scanning (@Component/@Service/@Repository), Dependency Injection (@Autowired), Application context (ApplicationContext). Main annotations: @SpringBootApplication = @Configuration + @EnableAutoConfiguration + @ComponentScan.",
      "jvm":"JVM Memory: Heap (Young Gen: Eden+Survivor, Old Gen), Stack (method frames), Metaspace (class metadata), PC Register, Native Stack. GC: Minor GC = Young gen. Major GC = Old gen. G1GC is default in Java 11+.",
      "design pattern":"Gang of Four patterns: Creational (Singleton, Factory, Builder, Prototype). Structural (Adapter, Decorator, Facade, Proxy). Behavioral (Observer, Strategy, Command, Iterator, Template Method).",
      "solid":"SOLID: S=Single Responsibility (one reason to change). O=Open/Closed (open to extend, closed to modify). L=Liskov Substitution (subclass must work as parent). I=Interface Segregation (small interfaces). D=Dependency Inversion (depend on abstractions)."
    }
  },
  sql: {
    topics: ["JOINs","Indexes","Transactions","PL/SQL","Window Functions","Performance","Normalization"],
    quickAnswers: {
      "normalization":"Normal Forms: 1NF=atomic values, no repeating groups. 2NF=full dependency on primary key. 3NF=no transitive dependency. BCNF=every determinant is a candidate key. Denormalization = intentionally breaking NF for performance.",
      "acid":"ACID: Atomicity=all or nothing (ROLLBACK). Consistency=DB rules always maintained. Isolation=concurrent transactions don't interfere (isolation levels). Durability=committed data persists (redo logs).",
      "pl/sql":"PL/SQL block structure: DECLARE (vars), BEGIN (logic), EXCEPTION (error handling), END. Cursor types: Implicit (auto for single-row SELECT INTO), Explicit (for loops). BULK COLLECT + FORALL = batch DML, 10-100x faster than row-by-row.",
      "execution plan":"Oracle EXPLAIN PLAN: Run 'EXPLAIN PLAN FOR [query]; SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)'. Key operations: TABLE ACCESS FULL (bad for large tables), INDEX RANGE SCAN (good), NESTED LOOPS vs HASH JOIN (hash better for large sets)."
    }
  },
  wms: {
    topics: ["LPN","Receiving","Putaway","Pick/Pack","Wave Planning","Inventory","Shipping"],
    quickAnswers: {
      "receiving":"WMS Receiving: ASN arrives → Match to PO → Generate LPN → Enter quantities → Confirm receipt → System updates on-hand → Triggers putaway. Key controls: over-receipt tolerance, quality inspection step, lot/serial control.",
      "picking":"WMS Picking process: Wave plan → Allocation → Task generation → Task dispatch to device → Operator confirms pick → Inventory decremented from locator → Move to staging. FEFO = pick nearest expiry first. Zone-based picking = different pickers per zone.",
      "inventory adjustment":"Inventory adjustments: Miscellaneous Issue (reduce on-hand), Miscellaneous Receipt (increase), Transfer (move between locators/subinventories). All require reason code. Adjustments above tolerance need manager approval before execution."
    }
  },
  scm: {
    topics: ["Procure-to-Pay","Order Management","Supplier","Inventory","Drop Ship","Back-to-Back"],
    quickAnswers: {
      "invoice hold":"AP Invoice Hold types: Price Variance (invoice price ≠ PO price beyond tolerance), Quantity (received qty ≠ invoiced qty), Receipt (no receipt exists), Quality. Resolution: 1) Verify root cause 2) Match cause: amend PO / create receipt / get credit memo 3) Release hold manually or re-run matching.",
      "routing":"Oracle SCM order routing: Standard (from stock), Back-to-Back (PO created per SO), Drop Ship (supplier ships to customer), Transfer Order (from another org), ATO/PTO (assemble/pick to order). Sourcing rules determine which routing applies."
    }
  },
  hcm: {
    topics: ["Hire","Payroll","Absence","Performance","Compensation","Benefits"],
    quickAnswers: {
      "hire":"Oracle HCM Hire flow: Create Person → Add Name/DOB → Create Work Relationship (Employee/Contingent) → Create Assignment → Select Legal Entity → Set Grade/Job/Position → Define Compensation → Assign Benefits → Set Start Date → Submit.",
      "element":"Payroll Elements: Recurring (every run, e.g. salary). Non-recurring (once, e.g. bonus). Input Values hold the amounts. Element Links connect elements to assignment groups. Element Entries are the employee-specific instance. FastFormula calculates the value."
    }
  },
  assets: {
    topics: ["Addition","Depreciation","Transfer","Revaluation","Retirement","CIP"],
    quickAnswers: {
      "additions":"Asset addition methods: 1) Manual (Add Asset form). 2) Mass Additions (from AP Payables). 3) CIP (Construction in Progress) — accumulates cost, no depreciation, reclassified when placed in service. Required: Asset Category, Cost, In-Service Date, Depreciation Method.",
      "impairment":"Asset Impairment: Reduce NBV when recoverable amount < carrying amount. In Oracle: use 'Impair Asset' transaction. Creates journal: Dr Impairment Loss, Cr Accumulated Impairment. Different from depreciation — not systematic, event-driven."
    }
  }
};

function buildAgentResponse(question, orgProfile) {
  const q = (question || "").toLowerCase();

  // TIER 1: Search user-uploaded document KB
  const docMatch = searchDocumentKB(question);
  if (docMatch) {
    const orgCtx = orgProfile?.orgName ? `\n\n🏢 ${orgProfile.orgName} context: ${orgProfile.tools||""} — ${orgProfile.workflows||""}` : "";
    return {
      title: `📄 ${docMatch.topic}`,
      explanation: `${docMatch.answer}${orgCtx}`,
      example: docMatch.example || null,
      followUp: `Would you like more depth on any part of this?`,
      source: "document"
    };
  }

  // TIER 2: Built-in KB — exact and fuzzy keyword match
  for (const [key, entry] of Object.entries(KB)) {
    const titleWords = entry.title.toLowerCase().split(/[\s&—,]+/);
    const matched =
      q.includes(key) ||
      titleWords.some(w => w.length > 3 && q.includes(w)) ||
      q.split(/\s+/).some(w => w.length > 4 && key.includes(w.slice(0, 5)));
    if (matched) {
      let explanation = entry.explanation;
      if (orgProfile?.orgName) {
        explanation += `\n\n🏢 ${orgProfile.orgName}: This applies when working on ${orgProfile.workflows || "your workflows"} using ${orgProfile.tools || "your stack"}.`;
      }
      return { title: entry.title, explanation, example: entry.example, followUp: entry.followUp, source: "kb" };
    }
  }

  // TIER 3: Domain Quick Answers — check specific patterns
  const domainChecks = [
    { domain: DOMAIN_KNOWLEDGE.java,   regex: /\bjava\b|spring|jvm|oops|oop|solid|interface|abstract|design.?pattern|annotation|bean|rest.?api/ },
    { domain: DOMAIN_KNOWLEDGE.sql,    regex: /\bsql\b|plsql|pl.sql|query|join|index|trigger|procedure|cursor|normali|acid|commit|rollback|explain.?plan/ },
    { domain: DOMAIN_KNOWLEDGE.wms,    regex: /wms|warehouse|lpn|receiv|putaway|pick|wave|cycle.?count|replenish|subinventory|locator|dispatch/ },
    { domain: DOMAIN_KNOWLEDGE.scm,    regex: /scm|supply.?chain|purchase|po\b|invoice|supplier|vendor|asn|requisition|routing|procure/ },
    { domain: DOMAIN_KNOWLEDGE.hcm,    regex: /hcm|\bhr\b|payroll|employee|worker|absence|leave|hire|element|grade|position|benefit|compensat/ },
    { domain: DOMAIN_KNOWLEDGE.assets, regex: /fixed.?asset|depreciat|capital|cip|retire|impair|revaluat|mass.?addition|nbv|useful.?life/ }
  ];

  for (const { domain, regex } of domainChecks) {
    if (regex.test(q)) {
      // Find best quick answer
      for (const [key, ans] of Object.entries(domain.quickAnswers)) {
        if (q.includes(key) || key.split(/\s+/).some(w => q.includes(w))) {
          return {
            title: `${key.charAt(0).toUpperCase() + key.slice(1)}`,
            explanation: ans,
            example: null,
            followUp: `Want me to go deeper on any part? Topics I can cover: ${domain.topics.join(", ")}.`,
            source: "domain"
          };
        }
      }
      // Domain matched but no specific quick answer — give topic overview
      const topicGuess = question.split(/\s+/).filter(w => w.length > 4).slice(0, 5).join(" ");
      const orgCtx = orgProfile?.orgName ? ` (tailored for ${orgProfile.orgName})` : "";
      return {
        title: `${topicGuess || "That topic"}${orgCtx}`,
        explanation: `I know this is about ${domain.topics.join(" / ")}. Here's what I can tell you:\n\n` +
          `📚 Ask me specifically about:\n${domain.topics.map(t => `• ${t}`).join("\n")}` +
          `\n\nOr try asking: "Explain ${domain.topics[0]}" or "What is ${domain.topics[1]}?"`,
        example: null,
        followUp: `What specific part of this would be most helpful to explain?",
        source: "domain"`
      };
    }
  }

  // TIER 4: Complete fallback — still helpful
  const topicGuess = question.split(/\s+/).filter(w => w.length > 3).slice(0, 5).join(" ");
  return {
    title: `Question: ${topicGuess || question}`,
    explanation: `I want to help you with: "${question}"\n\n` +
      `I have deep knowledge in these areas:\n\n` +
      `💻 Developer: Java (Spring, JVM, OOP, Design Patterns) | JavaScript (React, Promises, Event Loop) | SQL (PL/SQL, Indexes, Performance) | Python (Generators, Decorators, Context Managers)\n\n` +
      `📦 Functional: Oracle WMS (LPN, Picking, Wave Planning) | SCM (P2P, Drop Ship, Order Routing) | HCM (Payroll, Absence, Hire) | Fixed Assets (Depreciation, CIP, Mass Additions)\n\n` +
      `Try asking:\n→ "Explain HashMap in Java"\n→ "How does WMS putaway work?"\n→ "What is 3-way match in SCM?"\n→ "What is FEFO picking?"`,
    example: null,
    followUp: "Ask me anything about your module and I'll give you a detailed answer with examples.",
    source: "fallback"
  };
}

// ════════════════════════════════════════════════════════════
//   TRAINING MODULES
// ════════════════════════════════════════════════════════════

function buildTrainingModule(topic, orgProfile, failedData) {
  const topicLower = (topic || "").toLowerCase();
  const orgName = orgProfile?.orgName || "your organization";
  const orgTools = orgProfile?.tools || "your tech stack";

  let assessmentReview = null;
  if (failedData && failedData.questionTitle) {
      assessmentReview = {
          questionTitle: failedData.questionTitle,
          userAnswer: failedData.answer || "No answer provided",
          correction: failedData.correctionBlock?.explanation || "Incorrect answer."
      };
  }

  // Match KB entry for rich training
  for (const [key, entry] of Object.entries(KB)) {
    if (topicLower.includes(key) || key.includes(topicLower.split(/[\s-]/)[0])) {
      return {
        topic: entry.title, key,
        teach: entry.explanation,
        example: entry.example,
        scenario: `🏭 PRODUCTION SCENARIO at ${orgName} (using ${orgTools}):\n\n` +
          `A real-world issue has been raised related to "${entry.title}". ` +
          `The team needs immediate diagnosis and resolution.\n\n` +
          `${orgProfile?.workflows ? `Context: Your team works with: ${orgProfile.workflows}.` : "Apply what you learned above to diagnose the root cause."}`,
        question: {
          type: "descriptive",
          text: `Based on your understanding of "${entry.title}":\n\n${entry.followUp}`,
          expected: entry.title.toLowerCase().split(/\s+/).filter(w => w.length > 3),
          hint: "Refer to the explanation. Think about practical production implications."
        },
        assessmentReview
      };
    }
  }

  // Fallback
  return {
    topic, key: "generic",
    teach: `"${topic}" is a critical concept in your work domain. Understanding it prevents production issues and enables faster troubleshooting.`,
    example: `Apply the core principles of "${topic}" to solve real problems in ${orgName}.`,
    scenario: `🏭 SCENARIO at ${orgName}: A production issue related to "${topic}" has occurred. Your team needs you to diagnose and resolve it using your understanding of this concept.`,
    question: {
      type: "descriptive",
      text: `Explain "${topic}" in your own words. Give a real example from ${orgTools} where this concept matters most.`,
      expected: [topicLower.split(/\s+/)[0]],
      hint: "Focus on real-world production impact, not just theory."
    },
    assessmentReview
  };
}

// ════════════════════════════════════════════════════════════
//   FUZZY EVALUATOR
// ════════════════════════════════════════════════════════════

const SYNONYMS = {
  "hashmap":["hash map","hashtable","dictionary"],"null check":["optional","npe","null"],
  "BULK COLLECT":["bulk collect","forall"],"allocation":["alloc","wave"],
  "prorate":["prorata","convention"],"closure":["closed over","lexical"],
  "generator":["yield","lazy"],"decorator":["wrapper","@functools"]
};

function fuzzyMatch(text, kw) {
  const t = text.toLowerCase(); const k = kw.toLowerCase();
  if (t.includes(k)) return true;
  if (k.length > 4 && t.includes(k.slice(0, 5))) return true;
  return (SYNONYMS[kw] || SYNONYMS[k] || []).some(s => t.includes(s.toLowerCase()));
}

// ════════════════════════════════════════════════════════════
//   API STATUS TRACKING
// ════════════════════════════════════════════════════════════

let API_STATUS = { quizapi: false, leetcode: false, opentrivia: false, codeforces: false, lastChecked: null };

async function checkAPIs() {
  // QuizAPI
  if (QUIZAPI_KEY && QUIZAPI_KEY !== "your_quizapi_key_here") {
    try { const r = await fetch(`${QUIZAPI_BASE}?apiKey=${QUIZAPI_KEY}&limit=1`, { signal: AbortSignal.timeout(3000) }); API_STATUS.quizapi = r.ok; } catch { API_STATUS.quizapi = false; }
  }
  // LeetCode
  try {
    const r = await fetch(LEETCODE_GQL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `{ randomQuestion(categorySlug:"",filters:{}) { titleSlug } }` }),
      signal: AbortSignal.timeout(5000)
    });
    API_STATUS.leetcode = r.ok;
  } catch { API_STATUS.leetcode = false; }
  // Open Trivia DB (free, no key needed)
  try {
    const r = await fetch(`${OPENTRIVIA_BASE}?amount=1&category=18&type=multiple`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      API_STATUS.opentrivia = d.response_code === 0;
    } else { API_STATUS.opentrivia = false; }
  } catch { API_STATUS.opentrivia = false; }
  // Codeforces (free, no key for public data)
  try {
    const r = await fetch(`${CODEFORCES_BASE}/problemset.problems?tags=implementation&perPageCount=5`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) { const d = await r.json(); API_STATUS.codeforces = d.status === "OK"; }
    else { API_STATUS.codeforces = false; }
  } catch { API_STATUS.codeforces = false; }
  API_STATUS.lastChecked = new Date().toISOString();
  console.log(`   APIs: QuizAPI=${API_STATUS.quizapi} | LC=${API_STATUS.leetcode} | OpenTrivia=${API_STATUS.opentrivia} | CF=${API_STATUS.codeforces}`);
}
checkAPIs();

// ════════════════════════════════════════════════════════════
//   ENDPOINTS
// ════════════════════════════════════════════════════════════

// 1. GENERATE QUESTION
app.post("/generate-question", async (req, res) => {
  try {
    await delay();
    const {
      role, track, level, experience,
      questionNumber = 0,
      techStack = [],
      usedQuestionIds = []
    } = req.body;

    const safeRole = (role || "developer").toLowerCase() === "developer" ? "developer" : "functional";
    const difficulty = getApiDifficulty(experience, questionNumber, level || "Beginner");

    let apiTag = TECH_TAG_MAP[track] || track;
    if (techStack.length > 0) { const m = techStack.find(t => TECH_TAG_MAP[t]); if (m) apiTag = TECH_TAG_MAP[m]; }
    
    let question = null;
    const trackLC = (track || "").toLowerCase();

    // ─────────────────────────────────────────────────────────
    //  10-QUESTION STRICT FLOW: 4-3-2-1 Model
    // ─────────────────────────────────────────────────────────
    if (questionNumber < 4) {
      // Questions 0-3: 4 (MCQ + Code) strictly from Document KB
      const docTrackQs = DOCUMENT_KB.filter(q => (q.track || "").toLowerCase() === trackLC && !usedQuestionIds.includes(q.id));
      if (docTrackQs.length > 0) {
        question = shuffle(docTrackQs)[0];
      } else {
        // Fallback to local DB if document DB is exhausted
        question = selectFromDB(safeRole, track, "Beginner", usedQuestionIds, Math.random() > 0.5 ? "mcq" : "code");
      }
    } else if (questionNumber >= 4 && questionNumber < 7) {
      // Questions 4-6: 3 MCQ from external APIs with strict isolation
      if (API_STATUS.quizapi) {
        question = await fetchFromQuizAPI(apiTag, "Easy");
        if (question && question.track && question.track.toLowerCase() !== trackLC) question = null; // discard off-track
      }
      if (!question && API_STATUS.opentrivia && LC_ELIGIBLE_TRACKS.has(track)) {
         question = await fetchFromOpenTrivia("easy", track);
      }
      if (!question) {
        // API failed or exhausted, fallback to local DB MCQ
        question = selectFromDB(safeRole, track, "Beginner", usedQuestionIds, "mcq");
      }
    } else if (questionNumber >= 7 && questionNumber < 9) {
      // Questions 7-8: 2 Beginner coding / descriptive
      question = selectFromDB(safeRole, track, "Beginner", usedQuestionIds, "code");
      if (!question) question = selectFromDB(safeRole, track, "Beginner", usedQuestionIds, "descriptive"); // fallback to desc if no code
      if (!question && safeRole === "developer" && LC_ELIGIBLE_TRACKS.has(track)) {
         if (API_STATUS.leetcode) question = await fetchFromLeetCode("Easy", track);
         if (!question && API_STATUS.codeforces) question = await fetchFromCodeforces("Easy", track);
      }
    } else if (questionNumber === 9) {
      // Question 9: 1 Advanced coding
      question = selectFromDB(safeRole, track, "Advanced", usedQuestionIds, "code");
      if (!question && safeRole === "developer" && LC_ELIGIBLE_TRACKS.has(track)) {
         if (API_STATUS.leetcode) question = await fetchFromLeetCode("Hard", track);
         if (!question && API_STATUS.codeforces) question = await fetchFromCodeforces("Hard", track);
      }
    }

    // Absolute last resort (prevent crash if pools dry up)
    if (!question) {
      question = selectFromDB(safeRole, track, difficulty, [], "mcq"); 
    }

    if (question) question._selectedTrack = track;
    res.json({ success: true, question, source: question?.source || "Local DB" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// 2. EVALUATE ANSWER — with rich post-submit explanation (Fix 4)
app.post("/evaluate", async (req, res) => {
  try {
    await delay();
    const { answer, question, experience, usedHint, timeSpentSeconds, confidenceRating } = req.body;
    const q = question || {};
    let score = 0; let matched = []; let missed = [];
    let feedback = ""; let correctionBlock = null;

    // ──────────────────────────────────────────
    //  Build the FULL correct answer explanation
    //  For coding questions, build rich code block
    // ──────────────────────────────────────────
    let fullExplanation = q.correctAnswerText || "";

    // For LeetCode / Codeforces coding questions — generate a rich explanation block
    if ((q.type === "leetcode" || q.type === "code") && q.source && ["LeetCode","Codeforces"].includes(q.source)) {
      const tags = (q.topicTags || []).join(", ") || "Algorithms";
      const url = q.problemUrl || q.sourceUrl || "#";
      fullExplanation = [
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📖 SOLUTION GUIDE: ${q.title}`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `🔗 Full Problem: ${url}`,
        `🏷️ Topics: ${tags}`,
        ``,
        `📐 APPROACH:`,
        `Read the full problem at the link above. Key algorithmic patterns for tags [${tags}]:`,
        tags.includes("dynamic programming") ? `\n• DP: Define state dp[i] → recurse with memoization or build bottom-up table.` : ``,
        tags.includes("binary search") ? `\n• Binary Search: Find the invariant, search on answer if monotonic.` : ``,
        tags.includes("greedy") ? `\n• Greedy: Make locally optimal choice at each step — prove it gives global optimum.` : ``,
        tags.includes("graph") || tags.includes("bfs") || tags.includes("dfs") ? `\n• Graph: Use BFS for shortest path, DFS for connected components/cycles.` : ``,
        tags.includes("two pointers") ? `\n• Two Pointers: Left/right pointers converging from both ends or same direction.` : ``,
        tags.includes("hash") || tags.includes("map") ? `\n• HashMap: Store seen values to achieve O(1) lookup.` : ``,
        ``,
        `⏱️ COMPLEXITY GUIDE:`,
        `• Brute Force O(n²) → typically not accepted for n > 10^4`,
        `• Optimal: aim for O(n log n) or O(n) where possible`,
        `• Space: O(1) if in-place, O(n) for additional data structures`,
        ``,
        `💡 STUDY LINKS:`,
        `• Problem: ${url}`,
        `• Editorial (if available): ${url.replace("problems/", "problems/").replace(/\/$/, "")}/editorial`,
        q.source === "LeetCode" ? `• Discussion: https://leetcode.com/problems/${url.split("/problems/")[1]?.replace("/","") || ""}discuss/` : `• Codeforces editorial: look for tutorial tag in contest.`
      ].filter(Boolean).join("\n");
    }

    // For local DB code questions — use existing correctAnswerText (already has working code)
    if (q.type === "code" && q.source !== "LeetCode" && q.source !== "Codeforces") {
      fullExplanation = q.correctAnswerText
        ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📖 CORRECT ANSWER & EXPLANATION\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${q.correctAnswerText}`
        : fullExplanation;
    }

    // For MCQ — show why correct answer is right + why others are wrong
    if (q.type === "mcq") {
      const correctOpt = (q.options || []).find(o => o.trim().toUpperCase().startsWith(q.correctAnswer)) || `Option ${q.correctAnswer}`;
      fullExplanation = [
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📖 ANSWER EXPLANATION`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `✅ Correct: ${correctOpt}`,
        ``,
        q.correctAnswerText || `Review this concept in your ${q.track || ""} training module.`
      ].join("\n");
    }

    // For descriptive — show model answer with key points
    if (q.type === "descriptive" || q.type === "scenario") {
      fullExplanation = [
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `📖 MODEL ANSWER`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        q.correctAnswerText || `Key concepts: ${(q.expected || []).join(", ")}.`,
        ``,
        `🎯 Key concepts that should be in your answer: ${(q.expected || []).join(", ") || "See above."}`
      ].join("\n");
    }

    // ──────────────────────────────────────────
    //  SCORING LOGIC
    // ──────────────────────────────────────────
    if (q.type === "mcq") {
      const ansLetter = (answer || "").trim().toUpperCase().charAt(0);
      const isCorrect = ansLetter === (q.correctAnswer || "").toUpperCase();
      score = isCorrect ? 100 : 0;
      matched = isCorrect ? (q.expected || []) : [];
      missed = isCorrect ? [] : (q.expected || []);
      if (isCorrect) {
        feedback = `✅ Correct! Well done!`;
        correctionBlock = { isCorrect: true, correctOption: (q.options || []).find(o => o.trim().startsWith(q.correctAnswer)) || "", explanation: fullExplanation };
      } else {
        feedback = `❌ Incorrect. You selected "${String(answer).toUpperCase()}". Correct is: ${q.correctAnswer}.`;
        correctionBlock = { isCorrect: false, correctOption: (q.options || []).find(o => o.trim().startsWith(q.correctAnswer)) || `Option ${q.correctAnswer}`, explanation: fullExplanation };
      }
    } else if (q.type === "leetcode") {
      const lowerAns = (answer || "").toLowerCase();
      const base = lowerAns.length > 120 ? 30 : lowerAns.length > 50 ? 20 : lowerAns.length > 20 ? 10 : 5;
      const kws = q.expected?.length ? q.expected : ["algorithm", "complexity", "edge case"];
      kws.forEach(c => { if (fuzzyMatch(lowerAns, c)) { score += 20; matched.push(c); } else missed.push(c); });
      score = Math.min(base + score, 100);
      feedback = score >= 80 ? `🔥 Excellent! Strong algorithmic thinking. Covered: ${matched.join(", ")}.`
        : score >= 50 ? `👍 Good attempt. Covered: ${matched.join(", ")}. ${missed.length ? `Also explain: ${missed.join(", ")}.` : ""}`
        : `💡 Keep practicing. Open the problem link and study the approach. Missing: ${missed.join(", ")}.`;
      correctionBlock = { isCorrect: score >= 60, correctOption: null, explanation: fullExplanation };
    } else {
      // Descriptive / code / scenario / diagnostic
      const lowerAns = (answer || "").toLowerCase();
      const base = lowerAns.length > 100 ? 30 : lowerAns.length > 50 ? 20 : lowerAns.length > 20 ? 12 : 5;
      (q.expected || []).forEach(c => {
        if (fuzzyMatch(lowerAns, c)) { score += 18; matched.push(c); } else missed.push(c);
      });
      score = Math.min(base + score, 100);
      feedback = score >= 85 ? `🌟 Excellent! Deep understanding shown. Key points: ${matched.join(", ")}.`
        : score >= 65 ? `✅ Good answer! Covered: ${matched.join(", ")}. ${missed.length ? `Also mention: ${missed.join(", ")}.` : ""}`
        : score >= 40 ? `📝 Partially correct. Covered: ${matched.join(", ") || "some basics"}. Missing: ${missed.join(", ")}.`
        : `📚 Needs improvement. Study the model answer below. Key concepts: ${missed.join(", ") || (q.expected || []).join(", ")}.`;
      correctionBlock = { isCorrect: score >= 65, correctOption: null, explanation: fullExplanation };
    }

    // Hint deduction

    if (usedHint && experience === "Experienced") { score = Math.max(0, score - 15); feedback += "\n⚠️ −15pts: Hint used at Experienced level."; }

    // Time analysis
    const t = timeSpentSeconds || 0;
    const timeFlag = t < 15 && score >= 75 ? "⚡ Instinctive — fast and accurate!"
      : t < 15 && score < 50 ? "🚨 Risky — answered too quickly. Slow down."
      : t > 90 && score >= 70 ? "🧠 Deep Thinker — thorough and correct."
      : t > 90 && score < 50 ? "⏱️ Took long but still missed key concepts." : "";

    const conf = parseInt(confidenceRating || 3);
    const confFlag = conf >= 4 && score < 50 ? "📊 Confidence–Score Mismatch: High confidence but low score. Review this topic."
      : conf <= 2 && score > 80 ? "📊 Hidden Strength: Low self-rating but excellent answer!" : "";

    const LEVELS = ["Beginner", "Intermediate", "Advanced"];
    const ci = LEVELS.indexOf(q.level || "Beginner");
    const nextLevel = score >= 80 ? LEVELS[Math.min(ci + 1, 2)] : score < 40 ? "Beginner" : (q.level || "Beginner");

    res.json({
      success: true, result: {
        score: Math.round(score), feedback, correctionBlock,
        improvement: missed.length > 0 ? `Study: ${missed.join(", ")}` : "Excellent! Push to harder questions.",
        timeAnalysis: timeFlag, confidenceAnalysis: confFlag,
        strengths: matched, weaknesses: missed, nextLevel
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. TRAINING MODULE
app.post("/training-module", async (req, res) => {
  try {
    await delay();
    const { weakness, userTopic, orgProfile, failedData } = req.body;
    const topic = userTopic || weakness || "Core Concepts";
    res.json({ success: true, module: buildTrainingModule(topic, orgProfile, failedData) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. AGENT Q&A (flexible — handles any question)
app.post("/agent-ask", async (req, res) => {
  try {
    await delay();
    const { question, orgProfile } = req.body;
    res.json({ success: true, answer: buildAgentResponse(question, orgProfile) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. GENERATE REPORT
app.post("/generate-report", async (req, res) => {
  try {
    await delay();
    const { profile, answers } = req.body;
    const sp = profile || {}; const sa = answers || [];
    const avg = sa.length > 0 ? Math.round(sa.reduce((a, b) => a + (b.score || 0), 0) / sa.length) : 0;
    const strengths = [...new Set(sa.flatMap(a => a.strengths || []))].filter(Boolean).slice(0, 6);
    const weaknesses = [...new Set(sa.flatMap(a => a.weaknesses || []))].filter(Boolean).slice(0, 6);
    const avgTime = sa.length > 0 ? Math.round(sa.reduce((a, b) => a + (b.timeSpent || 0), 0) / sa.length) : 0;
    res.json({
      success: true, report: {
        name: sp.name, role: sp.role, experience: sp.experience, level: sp.selfLevel || "Beginner",
        averageScore: avg, strengths, weaknesses,
        riskLevel: avg < 40 ? "High" : avg < 70 ? "Medium" : "Low",
        averageTimePerQuestion: avgTime,
        recommendation: `Focus training on: ${weaknesses.slice(0, 3).join(", ") || "advanced topics"}.`,
        summary: `${sp.name} completed the ${sp.role} assessment (${sp.role === "Developer" ? sp.language : sp.domain}) with an average score of ${avg}/100 at ${sp.selfLevel || "Beginner"} level.`
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6. SAVE SESSION
app.post("/save-session", (req, res) => {
  try {
    const file = "data.json";
    let r = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : [];
    r.push({ id: Date.now(), ...req.body, timestamp: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(r, null, 2));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. LOAD DOCUMENT KB (from uploaded Java/Spring/SQL files)
// POST /load-doc-kb  body: { entries: [{topic, question, answer, tags, example?}] }
app.post("/load-doc-kb", (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries) || entries.length === 0)
      return res.status(400).json({ error: "entries[] required" });
    DOCUMENT_KB = [...DOCUMENT_KB, ...entries];
    console.log(`   📄 Document KB loaded: ${DOCUMENT_KB.length} total entries`);
    res.json({ success: true, loaded: entries.length, total: DOCUMENT_KB.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /doc-kb-status
app.get("/doc-kb-status", (_, res) => {
  res.json({ entries: DOCUMENT_KB.length, topics: [...new Set(DOCUMENT_KB.map(e => e.topic))] });
});

// HEALTH
app.get("/health", async (_, res) => {
  await checkAPIs();
  res.json({
    ok: true, engine: "V3.5",
    localDB: LOCAL_DB.length,
    kbTopics: Object.keys(KB).length,
    documentKB: DOCUMENT_KB.length,
    apis: {
      leetcode:   { status: API_STATUS.leetcode,   label: "LeetCode",    note: "Free, no key" },
      codeforces: { status: API_STATUS.codeforces, label: "Codeforces",  note: "Free, no key" },
      opentrivia: { status: API_STATUS.opentrivia, label: "OpenTrivia",  note: "Free, no key" },
      quizapi:    { status: API_STATUS.quizapi,    label: "QuizAPI",     note: "Free key required" }
    }
  });
});

// HOME
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "DevProbe.html"));
});

app.use((_, res) => res.status(404).json({ error: "Not found" }));
const PORT = parseInt(process.env.PORT) || 5003;
app.listen(PORT, async () => {
  await checkAPIs();
  const icon = s => s ? "✅" : "⚠️";
  console.log(`\n✅ DevProbe AI V3.5 — http://localhost:${PORT}`);
  console.log(`   Local DB: ${LOCAL_DB.length} Qs | Built-in KB: ${Object.keys(KB).length} topics | Document KB: ${DOCUMENT_KB.length}`);
  console.log(`   ${icon(API_STATUS.leetcode)}  LeetCode (free)  |  ${icon(API_STATUS.codeforces)} Codeforces (free)`);
  console.log(`   ${icon(API_STATUS.opentrivia)} OpenTrivia (free) |  ${icon(API_STATUS.quizapi)}  QuizAPI (${QUIZAPI_KEY && QUIZAPI_KEY !== "your_quizapi_key_here" ? "key set" : "key missing"})`); 
  console.log(`   POST /load-doc-kb to inject Java/Spring/SQL file knowledge\n`);
});
