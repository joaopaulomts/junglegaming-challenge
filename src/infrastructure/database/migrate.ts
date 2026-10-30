import { MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "./mikro-config";

const command = process.argv[2] ?? "up";

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL ?? "";
	if (databaseUrl.length === 0) {
		throw new Error("DATABASE_URL is required");
	}
	const orm = await MikroORM.init(databaseConfig(databaseUrl));
	try {
		if (command === "up") {
			await orm.getMigrator().up();
			console.log("migrations applied");
		} else if (command === "down") {
			await orm.getMigrator().down();
			console.log("migrations reverted");
		} else if (command === "init") {
			const generator = orm.getSchemaGenerator();
			await generator.ensureDatabase();
			await orm.getMigrator().up();
			console.log("schema ensured and migrations applied");
		} else {
			throw new Error(`unknown migrate command ${command}`);
		}
	} finally {
		await orm.close(true);
	}
}

void main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
