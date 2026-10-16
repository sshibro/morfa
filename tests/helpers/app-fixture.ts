import {mkdtemp,rm,lstat,chmod,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import type {Express} from 'express';
import {createDatabase,type Database} from '../../server/postgresql/client';
import {loadDatabaseConfig} from '../../server/postgresql/config';
import {migrateDatabase} from '../../server/postgresql/migrations';
import {createPostgresqlTestDatabase,type PostgresqlTestDatabase} from './postgresql';

export interface AppFixture {db:Database;app:Express;server:Server;base:string;dataDir:string;isolated:PostgresqlTestDatabase;drain():Promise<void>;close():Promise<void>}
/** Top-level-hook variant of the runtime fixture for whole-application suites:
 * one freshly migrated database bound to the application module, the app
 * listening on a loopback port. Each test file runs in its own process, so one boot per file. */
export async function bootPostgresqlApp(options:{env?:NodeJS.ProcessEnv;listen?:boolean}={}):Promise<AppFixture>{
  if(process.env.MORFA_DATABASE_URL)throw Error('An app fixture must not replace an existing application database configuration.');
  const isolated=await createPostgresqlTestDatabase(),dataDir=await mkdtemp(path.join(tmpdir(),'morfa-app-'));
  const env={...process.env,...isolated.env,NODE_ENV:'test',DATA_DIR:dataDir};
  const migration=createDatabase(loadDatabaseConfig('migration',env));
  await migrateDatabase(migration,{mode:'fresh',runtimeRole:isolated.roles.runtime,backupRole:isolated.roles.backup});
  process.env.MORFA_DATABASE_URL=isolated.runtimeUrl;process.env.NODE_ENV='test';process.env.DATA_DIR=dataDir;Object.assign(process.env,options.env);
  const storage=await import('../../server/db');await storage.initializeDatabase();
  const {app,drainAppTasks}=await import('../../server/app');
  let server:Server|undefined,base='';
  if(options.listen!==false){server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));base='http://127.0.0.1:'+(server.address() as {port:number}).port;}
  return {db:storage.db,app,server:server!,base,dataDir,isolated,drain:async()=>{await drainAppTasks();await (await import('../../server/admin/telemetry')).drainTelemetry();},async close(){
    if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}
    await drainAppTasks().catch(()=>{});await storage.closeDatabase().catch(()=>{});
    await migration.close().catch(()=>{});await isolated.close();await removeDataDir(dataDir);
    delete process.env.MORFA_DATABASE_URL;
  }};
}
/** Removes a data directory whose release builds were made immutable. */
export async function removeDataDir(directory:string):Promise<void>{
  async function writable(target:string){const info=await lstat(target).catch(()=>undefined);if(!info||info.isSymbolicLink())return;
    if(info.isDirectory()){await chmod(target,0o700);for(const entry of await readdir(target))await writable(path.join(target,entry));}else await chmod(target,0o600);}
  await writable(directory);await rm(directory,{recursive:true,force:true});
}
/** Owner-role connection for suites that need DDL, such as a deliberately failing trigger. Close it after use. */
export function migrationDatabase(fixture:{isolated:PostgresqlTestDatabase}):Database{
  return createDatabase(loadDatabaseConfig('migration',{...process.env,...fixture.isolated.env}));
}
/** Database-only variant for suites that assemble their own Express app. */
export async function bootPostgresqlDatabase(options:{env?:NodeJS.ProcessEnv}={}):Promise<{db:Database;dataDir:string;isolated:PostgresqlTestDatabase;close():Promise<void>}>{
  if(process.env.MORFA_DATABASE_URL)throw Error('A database fixture must not replace an existing application database configuration.');
  const isolated=await createPostgresqlTestDatabase(),dataDir=await mkdtemp(path.join(tmpdir(),'morfa-db-'));
  const env={...process.env,...isolated.env,NODE_ENV:'test',DATA_DIR:dataDir};
  const migration=createDatabase(loadDatabaseConfig('migration',env));
  await migrateDatabase(migration,{mode:'fresh',runtimeRole:isolated.roles.runtime,backupRole:isolated.roles.backup});
  process.env.MORFA_DATABASE_URL=isolated.runtimeUrl;process.env.NODE_ENV='test';process.env.DATA_DIR=dataDir;Object.assign(process.env,options.env);
  const storage=await import('../../server/db');await storage.initializeDatabase();
  return {db:storage.db,dataDir,isolated,async close(){await storage.closeDatabase().catch(()=>{});await migration.close().catch(()=>{});await isolated.close();await removeDataDir(dataDir);delete process.env.MORFA_DATABASE_URL;}};
}
