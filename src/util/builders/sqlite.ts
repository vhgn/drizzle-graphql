import { createTableRelationsHelpers, is, Relation, Relations, Table } from 'drizzle-orm';
import { BaseSQLiteDatabase, SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import {
	GraphQLError,
	GraphQLInputObjectType,
	GraphQLInt,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
} from 'graphql';

import {
	databaseOfContext,
	extractFilters,
	extractOrderBy,
	extractRelationsParams,
	extractSelectedColumnsFromTree,
	extractSelectedColumnsFromTreeSQLFormat,
	generateTableTypes,
} from '@/util/builders/common';
import { capitalize, uncapitalize } from '@/util/case-ops';
import {
	remapFromGraphQLArrayInput,
	remapFromGraphQLSingleInput,
	remapToGraphQLArrayOutput,
	remapToGraphQLSingleOutput,
} from '@/util/data-mappers';
import { parseResolveInfo } from 'graphql-parse-resolve-info';

import type { GeneratedEntities } from '@/types';
import type { RelationalQueryBuilder } from 'drizzle-orm/mysql-core/query-builders/query';
import type { GraphQLFieldConfig, GraphQLFieldConfigArgumentMap, ThunkObjMap } from 'graphql';
import type { ResolveTree } from 'graphql-parse-resolve-info';
import type { CreatedResolver, Filters, TableNamedRelations, TableSelectArgs } from './types';

const generateSelectArray = (
	db: BaseSQLiteDatabase<any, any, any, any>,
	tableName: string,
	tables: Record<string, Table>,
	relationMap: Record<string, Record<string, TableNamedRelations>>,
	orderArgs: GraphQLInputObjectType,
	filterArgs: GraphQLInputObjectType,
): CreatedResolver => {
	const queryName = `${uncapitalize(tableName)}`;

	const queryArgs = {
		offset: {
			type: GraphQLInt,
		},
		limit: {
			type: GraphQLInt,
		},
		orderBy: {
			type: orderArgs,
		},
		where: {
			type: filterArgs,
		},
	} as GraphQLFieldConfigArgumentMap;

	const typeName = `${capitalize(tableName)}SelectItem`;
	const table = tables[tableName]!;

	return {
		name: queryName,
		resolver: async (source, args: Partial<TableSelectArgs>, context, info) => {
			try {
				const { offset, limit, orderBy, where } = args;

				const parsedInfo = parseResolveInfo(info, {
					deep: true,
				}) as ResolveTree;

				const dynamicDb = databaseOfContext(db, context);
				const queryBase = dynamicDb.query[tableName as keyof typeof db.query] as unknown as
					| RelationalQueryBuilder<any, any, any>
					| undefined;
				if (!queryBase) {
					throw new Error(
						`Drizzle-GraphQL Error: Table ${tableName} not found in drizzle instance. Did you forget to pass schema to drizzle constructor?`,
					);
				}

				const query = queryBase.findMany({
					columns: extractSelectedColumnsFromTree(
						parsedInfo.fieldsByTypeName[typeName]!,
						table,
					),
					offset,
					limit,
					orderBy: orderBy ? extractOrderBy(table, orderBy) : undefined,
					where: where ? extractFilters(table, tableName, where) : undefined,
					with: relationMap[tableName]
						? extractRelationsParams(relationMap, tables, tableName, parsedInfo, typeName)
						: undefined,
				});

				const result = await query;

				return remapToGraphQLArrayOutput(result, tableName, table, relationMap);
			} catch (e) {
				if (typeof e === 'object' && typeof (<any> e).message === 'string') {
					throw new GraphQLError((<any> e).message);
				}

				throw e;
			}
		},
		args: queryArgs,
	};
};

const generateSelectSingle = (
	db: BaseSQLiteDatabase<any, any, any, any>,
	tableName: string,
	tables: Record<string, Table>,
	relationMap: Record<string, Record<string, TableNamedRelations>>,
	orderArgs: GraphQLInputObjectType,
	filterArgs: GraphQLInputObjectType,
): CreatedResolver => {
	const queryName = `${uncapitalize(tableName)}Single`;

	const queryArgs = {
		offset: {
			type: GraphQLInt,
		},
		orderBy: {
			type: orderArgs,
		},
		where: {
			type: filterArgs,
		},
	} as GraphQLFieldConfigArgumentMap;

	const typeName = `${capitalize(tableName)}SelectItem`;
	const table = tables[tableName]!;

	return {
		name: queryName,
		resolver: async (source, args: Partial<TableSelectArgs>, context, info) => {
			try {
				const { offset, orderBy, where } = args;

				const parsedInfo = parseResolveInfo(info, {
					deep: true,
				}) as ResolveTree;

				const dynamicDb = databaseOfContext(db, context);
				const queryBase = dynamicDb.query[tableName as keyof typeof db.query] as unknown as
					| RelationalQueryBuilder<any, any, any>
					| undefined;
				if (!queryBase) {
					throw new Error(
						`Drizzle-GraphQL Error: Table ${tableName} not found in drizzle instance. Did you forget to pass schema to drizzle constructor?`,
					);
				}

				const query = queryBase.findFirst({
					columns: extractSelectedColumnsFromTree(
						parsedInfo.fieldsByTypeName[typeName]!,
						table,
					),
					offset,
					orderBy: orderBy ? extractOrderBy(table, orderBy) : undefined,
					where: where ? extractFilters(table, tableName, where) : undefined,
					with: relationMap[tableName]
						? extractRelationsParams(relationMap, tables, tableName, parsedInfo, typeName)
						: undefined,
				});

				const result = await query;
				if (!result) return undefined;

				return remapToGraphQLSingleOutput(result, tableName, table, relationMap);
			} catch (e) {
				if (typeof e === 'object' && typeof (<any> e).message === 'string') {
					throw new GraphQLError((<any> e).message);
				}

				throw e;
			}
		},
		args: queryArgs,
	};
};

const generateInsertArray = (
	db: BaseSQLiteDatabase<any, any, any, any>,
	tableName: string,
	table: SQLiteTable,
	baseType: GraphQLInputObjectType,
): CreatedResolver => {
	const queryName = `insertInto${capitalize(tableName)}`;
	const typeName = `${capitalize(tableName)}Item`;

	const queryArgs: GraphQLFieldConfigArgumentMap = {
		values: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(baseType))),
		},
	};

	return {
		name: queryName,
		resolver: async (source, args: { values: Record<string, any>[] }, context, info) => {
			try {
				const input = remapFromGraphQLArrayInput(args.values, table);
				if (!input.length) throw new GraphQLError('No values were provided!');

				const parsedInfo = parseResolveInfo(info, {
					deep: true,
				}) as ResolveTree;

				const columns = extractSelectedColumnsFromTreeSQLFormat<SQLiteColumn>(
					parsedInfo.fieldsByTypeName[typeName]!,
					table,
				);

				const result = await db
					.insert(table)
					.values(input)
					.returning(columns)
					.onConflictDoNothing();

				return remapToGraphQLArrayOutput(result, tableName, table);
			} catch (e) {
				if (typeof e === 'object' && typeof (<any> e).message === 'string') {
					throw new GraphQLError((<any> e).message);
				}

				throw e;
			}
		},
		args: queryArgs,
	};
};

const generateInsertSingle = (
	db: BaseSQLiteDatabase<any, any, any, any>,
	tableName: string,
	table: SQLiteTable,
	baseType: GraphQLInputObjectType,
): CreatedResolver => {
	const queryName = `insertInto${capitalize(tableName)}Single`;
	const typeName = `${capitalize(tableName)}Item`;

	const queryArgs: GraphQLFieldConfigArgumentMap = {
		values: {
			type: new GraphQLNonNull(baseType),
		},
	};

	return {
		name: queryName,
		resolver: async (source, args: { values: Record<string, any> }, context, info) => {
			try {
				const input = remapFromGraphQLSingleInput(args.values, table);

				const parsedInfo = parseResolveInfo(info, {
					deep: true,
				}) as ResolveTree;

				const columns = extractSelectedColumnsFromTreeSQLFormat<SQLiteColumn>(
					parsedInfo.fieldsByTypeName[typeName]!,
					table,
				);

				const dynamicDb = databaseOfContext(db, context);
				const result = await dynamicDb.insert(table).values(input).returning(columns).onConflictDoNothing();

				if (!result[0]) return undefined;

				return remapToGraphQLSingleOutput(result[0], tableName, table);
			} catch (e) {
				if (typeof e === 'object' && typeof (<any> e).message === 'string') {
					throw new GraphQLError((<any> e).message);
				}

				throw e;
			}
		},
		args: queryArgs,
	};
};

const generateUpdate = (
	db: BaseSQLiteDatabase<any, any, any, any>,
	tableName: string,
	table: SQLiteTable,
	setArgs: GraphQLInputObjectType,
	filterArgs: GraphQLInputObjectType,
): CreatedResolver => {
	const queryName = `update${capitalize(tableName)}`;
	const typeName = `${capitalize(tableName)}Item`;

	const queryArgs = {
		set: {
			type: new GraphQLNonNull(setArgs),
		},
		where: {
			type: filterArgs,
		},
	} as const satisfies GraphQLFieldConfigArgumentMap;

	return {
		name: queryName,
		resolver: async (source, args: { where?: Filters<Table>; set: Record<string, any> }, context, info) => {
			try {
				const { where, set } = args;

				const parsedInfo = parseResolveInfo(info, {
					deep: true,
				}) as ResolveTree;

				const columns = extractSelectedColumnsFromTreeSQLFormat<SQLiteColumn>(
					parsedInfo.fieldsByTypeName[typeName]!,
					table,
				);

				const input = remapFromGraphQLSingleInput(set, table);
				if (!Object.keys(input).length) throw new GraphQLError('Unable to update with no values specified!');

				const dynamicDb = databaseOfContext(db, context);
				let query = dynamicDb.update(table).set(input);
				if (where) {
					const filters = extractFilters(table, tableName, where);
					query = query.where(filters) as any;
				}

				query = query.returning(columns) as any;

				const result = await query;

				return remapToGraphQLArrayOutput(result, tableName, table);
			} catch (e) {
				if (typeof e === 'object' && typeof (<any> e).message === 'string') {
					throw new GraphQLError((<any> e).message);
				}

				throw e;
			}
		},
		args: queryArgs,
	};
};

const generateDelete = (
	db: BaseSQLiteDatabase<any, any, any, any>,
	tableName: string,
	table: SQLiteTable,
	filterArgs: GraphQLInputObjectType,
): CreatedResolver => {
	const queryName = `deleteFrom${capitalize(tableName)}`;
	const typeName = `${capitalize(tableName)}Item`;

	const queryArgs = {
		where: {
			type: filterArgs,
		},
	} as const satisfies GraphQLFieldConfigArgumentMap;

	return {
		name: queryName,
		resolver: async (source, args: { where?: Filters<Table> }, context, info) => {
			try {
				const { where } = args;

				const parsedInfo = parseResolveInfo(info, {
					deep: true,
				}) as ResolveTree;

				const columns = extractSelectedColumnsFromTreeSQLFormat<SQLiteColumn>(
					parsedInfo.fieldsByTypeName[typeName]!,
					table,
				);

				const dynamicDb = databaseOfContext(db, context);
				let query = dynamicDb.delete(table);
				if (where) {
					const filters = extractFilters(table, tableName, where);
					query = query.where(filters) as any;
				}

				query = query.returning(columns) as any;

				const result = await query;

				return remapToGraphQLArrayOutput(result, tableName, table);
			} catch (e) {
				if (typeof e === 'object' && typeof (<any> e).message === 'string') {
					throw new GraphQLError((<any> e).message);
				}

				throw e;
			}
		},
		args: queryArgs,
	};
};

export const generateSchemaData = <
	TDrizzleInstance extends BaseSQLiteDatabase<any, any, any, any>,
	TSchema extends Record<string, Table | unknown>,
>(
	db: TDrizzleInstance,
	schema: TSchema,
	relationsDepthLimit: number | undefined,
): GeneratedEntities<TDrizzleInstance, TSchema> => {
	const rawSchema = schema;
	const schemaEntries = Object.entries(rawSchema);

	const tableEntries = schemaEntries.filter(([key, value]) => is(value, SQLiteTable)) as [string, SQLiteTable][];
	const tables = Object.fromEntries(tableEntries) as Record<
		string,
		SQLiteTable
	>;

	if (!tableEntries.length) {
		throw new Error(
			"Drizzle-GraphQL Error: No tables detected in Drizzle-ORM's database instance. Did you forget to pass schema to drizzle constructor?",
		);
	}

	const rawRelations = schemaEntries
		.filter(([key, value]) => is(value, Relations))
		.map<[string, Relations]>(([key, value]) => [
			tableEntries.find(
				([tableName, tableValue]) => tableValue === (value as Relations).table,
			)![0] as string,
			value as Relations,
		]).map<[string, Record<string, Relation>]>(([tableName, relValue]) => [
			tableName,
			relValue.config(createTableRelationsHelpers(tables[tableName]!)),
		]);

	const namedRelations = Object.fromEntries(
		rawRelations
			.map(([relName, config]) => {
				const namedConfig: Record<string, TableNamedRelations> = Object.fromEntries(
					Object.entries(config).map(([innerRelName, innerRelValue]) => [innerRelName, {
						relation: innerRelValue,
						targetTableName: tableEntries.find(([tableName, tableValue]) =>
							tableValue === innerRelValue.referencedTable
						)![0],
					}]),
				);

				return [
					relName,
					namedConfig,
				];
			}),
	);

	const queries: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};
	const mutations: ThunkObjMap<GraphQLFieldConfig<any, any>> = {};
	const gqlSchemaTypes = Object.fromEntries(
		Object.entries(tables).map(([tableName, table]) => [
			tableName,
			generateTableTypes(tableName, tables, namedRelations, true, relationsDepthLimit),
		]),
	);

	const inputs: Record<string, GraphQLInputObjectType> = {};
	const outputs: Record<string, GraphQLObjectType> = {};

	for (const [tableName, tableTypes] of Object.entries(gqlSchemaTypes)) {
		const { insertInput, updateInput, tableFilters, tableOrder } = tableTypes.inputs;
		const { selectSingleOutput, selectArrOutput, singleTableItemOutput, arrTableItemOutput } = tableTypes.outputs;

		const selectArrGenerated = generateSelectArray(
			db,
			tableName,
			tables,
			namedRelations,
			tableOrder,
			tableFilters,
		);
		const selectSingleGenerated = generateSelectSingle(
			db,
			tableName,
			tables,
			namedRelations,
			tableOrder,
			tableFilters,
		);
		const insertArrGenerated = generateInsertArray(db, tableName, schema[tableName] as SQLiteTable, insertInput);
		const insertSingleGenerated = generateInsertSingle(db, tableName, schema[tableName] as SQLiteTable, insertInput);
		const updateGenerated = generateUpdate(
			db,
			tableName,
			schema[tableName] as SQLiteTable,
			updateInput,
			tableFilters,
		);
		const deleteGenerated = generateDelete(db, tableName, schema[tableName] as SQLiteTable, tableFilters);

		queries[selectArrGenerated.name] = {
			type: selectArrOutput,
			args: selectArrGenerated.args,
			resolve: selectArrGenerated.resolver,
		};
		queries[selectSingleGenerated.name] = {
			type: selectSingleOutput,
			args: selectSingleGenerated.args,
			resolve: selectSingleGenerated.resolver,
		};
		mutations[insertArrGenerated.name] = {
			type: arrTableItemOutput,
			args: insertArrGenerated.args,
			resolve: insertArrGenerated.resolver,
		};
		mutations[insertSingleGenerated.name] = {
			type: singleTableItemOutput,
			args: insertSingleGenerated.args,
			resolve: insertSingleGenerated.resolver,
		};
		mutations[updateGenerated.name] = {
			type: arrTableItemOutput,
			args: updateGenerated.args,
			resolve: updateGenerated.resolver,
		};
		mutations[deleteGenerated.name] = {
			type: arrTableItemOutput,
			args: deleteGenerated.args,
			resolve: deleteGenerated.resolver,
		};
		[insertInput, updateInput, tableFilters, tableOrder].forEach((e) => (inputs[e.name] = e));
		outputs[selectSingleOutput.name] = selectSingleOutput;
		outputs[singleTableItemOutput.name] = singleTableItemOutput;
	}

	return { queries, mutations, inputs, types: outputs } as any;
};
