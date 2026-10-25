// ISO 17442: 18 capital letters or digits and 2 check digits, valid when the number formed by replacing each
// letter with its value (A = 10 ... Z = 35) is 1 modulo 97.
export function isValidLei(lei: string): boolean {
  if (!/^[0-9A-Z]{18}[0-9]{2}$/.test(lei)) return false;
  let remainder = 0;
  for (const char of lei) {
    const digits = String(parseInt(char, 36));
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
