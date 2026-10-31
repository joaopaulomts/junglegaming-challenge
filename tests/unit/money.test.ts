import { describe, expect, test } from "bun:test";
import { Money, MAX_AMOUNT } from "../../src/domain/shared/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/shared/errors";

describe("Money", () => {
	test("keeps a fixed 2-decimal scale on serialization", () => {
		expect(Money.from({ amount: "25.00", currency: "BRL" }).toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
		expect(Money.from({ amount: "0.00", currency: "BRL" }).toString()).toBe("0.00 BRL");
		expect(Money.from({ amount: "7.30", currency: "USD" }).toJSON().amount).toBe("7.30");
	});

	test("json and toString agree on the amount and the currency", () => {
		const m = Money.from({ amount: "1234.55", currency: "BRL" });
		expect(m.toJSON()).toEqual({ amount: "1234.55", currency: "BRL" });
		expect(m.toString()).toBe("1234.55 BRL");
	});

	test("rejects non-canonical inputs", () => {
		expect(() => Money.from({ amount: "25", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "25.000", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "25.1", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "   ", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "1e2", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "+25.00", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: ".50", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "2.50 ", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "not-a-number", currency: "BRL" })).toThrow(InvalidMoneyError);
	});

	test("rejects non-string and non-numeric NaN/Infinity values", () => {
		expect(() => Money.from({ amount: Number.NaN as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() =>
			Money.from({ amount: Number.POSITIVE_INFINITY as unknown as string, currency: "BRL" }),
		).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: 25.5 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: null as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: undefined as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
	});

	test("rejects negative amounts in input contracts — including negative zero", () => {
		expect(() => Money.from({ amount: "-0.01", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "-0.00", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "-999999999999.99", currency: "BRL" })).toThrow(InvalidMoneyError);
	});

	test("rejects a malformed currency", () => {
		expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "1.00", currency: "BRLX" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "1.00", currency: "" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "1.00", currency: Number.NaN as unknown as string })).toThrow(InvalidMoneyError);
	});

	test("enforces the maximum amount", () => {
		expect(Money.from({ amount: MAX_AMOUNT, currency: "BRL" }).toJSON().amount).toBe("999999999999.99");
		expect(() => Money.from({ amount: "1000000000000.00", currency: "BRL" })).toThrow(InvalidMoneyError);
	});

	test("large values stay exact", () => {
		const big = Money.from({ amount: "999999999999.99", currency: "BRL" });
		const one = Money.from({ amount: "1.01", currency: "BRL" });
		expect(big.subtract(one).toJSON().amount).toBe("999999999998.98");
		expect(Money.from({ amount: "999999999999.99", currency: "BRL" }).add(Money.zero("BRL")).toJSON().amount).toBe(
			"999999999999.99",
		);
	});

	test("never introduces float artifacts (0.1 + 0.2 is exactly 0.30)", () => {
		const sum = Money.from({ amount: "0.10", currency: "BRL" }).add(Money.from({ amount: "0.20", currency: "BRL" }));
		expect(sum.toJSON().amount).toBe("0.30");
		expect(sum.equals(Money.from({ amount: "0.30", currency: "BRL" }))).toBe(true);
	});

	test("operations return new instances and never mutate", () => {
		const a = Money.from({ amount: "10.00", currency: "BRL" });
		const b = Money.from({ amount: "2.50", currency: "BRL" });
		const sum = a.add(b);

		expect(sum.toJSON().amount).toBe("12.50");
		expect(a.toJSON().amount).toBe("10.00");
		expect(b.toJSON().amount).toBe("2.50");
		expect(a.subtract(b).toJSON().amount).toBe("7.50");
		expect(a.isPositive()).toBe(true);
		expect(Money.zero("BRL").isZero()).toBe(true);
		expect(a.isLessThan(sum)).toBe(true);
	});

	test("zero flags agree", () => {
		const zero = Money.zero("BRL");
		expect(zero.isZero()).toBe(true);
		expect(zero.isPositive()).toBe(false);
		expect(zero.isNegative()).toBe(false);
		expect(zero.add(zero).isZero()).toBe(true);
		expect(Money.from({ amount: "0.01", currency: "BRL" }).isPositive()).toBe(true);
	});

	test("negate flips the sign without mutating (internal value, not via from)", () => {
		const a = Money.from({ amount: "25.00", currency: "BRL" });
		const negated = a.negate();
		expect(negated.toJSON().amount).toBe("-25.00");
		expect(a.toJSON().amount).toBe("25.00");
		expect(negated.isNegative()).toBe(true);
		expect(negated.negate().equals(a)).toBe(true);
	});

	test("subtract may go below zero (internal arithmetic); direction is a ledger concern", () => {
		const result = Money.from({ amount: "10.00", currency: "BRL" }).subtract(Money.from({ amount: "25.00", currency: "BRL" }));
		expect(result.toJSON().amount).toBe("-15.00");
		expect(result.isNegative()).toBe(true);
	});

	test("comparison helpers", () => {
		const big = Money.from({ amount: "10.00", currency: "BRL" });
		const small = Money.from({ amount: "9.99", currency: "BRL" });
		expect(big.isLessThan(small)).toBe(false);
		expect(small.isLessThan(big)).toBe(true);
		expect(big.equals(Money.from({ amount: "10.00", currency: "BRL" }))).toBe(true);
		expect(big.equals(Money.from({ amount: "10.01", currency: "BRL" }))).toBe(false);
	});

	test("refuses arithmetic across currencies", () => {
		const brl = Money.from({ amount: "1.00", currency: "BRL" });
		const usd = Money.from({ amount: "1.00", currency: "USD" });
		expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
		expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
		expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
		expect(brl.equals(usd)).toBe(false);
	});
});
