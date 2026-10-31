import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/shared/money";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/shared/errors";

describe("Money", () => {
	test("keeps a fixed 2-decimal scale on serialization", () => {
		expect(Money.from({ amount: "25.00", currency: "BRL" }).toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
		expect(Money.from({ amount: "0.00", currency: "BRL" }).toString()).toBe("0.00 BRL");
	});

	test("rejects non-canonical input", () => {
		expect(() => Money.from({ amount: "25", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "25.000", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "1e2", currency: "BRL" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "not-a-number", currency: "BRL" })).toThrow(InvalidMoneyError);
	});

	test("rejects negative amounts in input contracts", () => {
		expect(() => Money.from({ amount: "-0.01", currency: "BRL" })).toThrow(InvalidMoneyError);
	});

	test("rejects a malformed currency", () => {
		expect(() => Money.from({ amount: "1.00", currency: "brl" })).toThrow(InvalidMoneyError);
		expect(() => Money.from({ amount: "1.00", currency: "BRLX" })).toThrow(InvalidMoneyError);
	});

	test("operations return new instances and never mutate", () => {
		const a = Money.from({ amount: "10.00", currency: "BRL" });
		const b = Money.from({ amount: "2.50", currency: "BRL" });
		const sum = a.add(b);

		expect(sum.toJSON().amount).toBe("12.50");
		expect(a.toJSON().amount).toBe("10.00");
		expect(a.subtract(b).toJSON().amount).toBe("7.50");
		expect(a.isPositive()).toBe(true);
		expect(Money.zero("BRL").isZero()).toBe(true);
		expect(a.isLessThan(sum)).toBe(true);
	});

	test("refuses arithmetic across currencies", () => {
		const brl = Money.from({ amount: "1.00", currency: "BRL" });
		const usd = Money.from({ amount: "1.00", currency: "USD" });
		expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
		expect(brl.equals(usd)).toBe(false);
	});
});
