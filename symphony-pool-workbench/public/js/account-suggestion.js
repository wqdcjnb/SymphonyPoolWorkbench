const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

function ordinal(number) {
  if (number === 10) return "十";
  if (number < 10) return digits[number];
  if (number < 20) return `十${digits[number % 10]}`;
  if (number < 100) return `${digits[Math.floor(number / 10)]}十${digits[number % 10]}`;
  return String(number);
}

export function suggestAccount(accounts, loginType, workerId) {
  const platform = loginType === "doubao" ? "doubao" : loginType === "dola" ? "dola" : "symphony";
  const node = String(workerId || "").trim();
  const prefix = `${node ? `${node}-` : ''}${platform}-`;
  const used = new Set(accounts.map((account) => account.id.toLowerCase()));
  const numbers = accounts.filter((account) => account.id.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((account) => account.id.slice(prefix.length))
    .filter((suffix) => /^\d+$/.test(suffix))
    .map(Number)
    .filter(Number.isSafeInteger);
  let next = Math.max(0, ...numbers) + 1;
  let id;
  do {
    id = `${prefix}${String(next).padStart(2, "0")}`;
    if (!used.has(id.toLowerCase())) break;
    next += 1;
  } while (true);
  const label = loginType === "doubao"
    ? `豆包${ordinal(next)}号账号`
    : loginType === "dola" ? `Dola ${ordinal(next)}号账号` : `Symphony TK ${ordinal(next)}号账号`;
  return { id, label };
}
