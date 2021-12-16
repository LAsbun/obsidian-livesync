import { debounce, Notice, Plugin, TFile, addIcon, TFolder, normalizePath, TAbstractFile, Editor, MarkdownView, PluginManifest } from "obsidian";
import { diff_match_patch } from "diff-match-patch";

import { EntryDoc, LoadedEntry, ObsidianLiveSyncSettings, diff_check_result, diff_result_leaf, EntryBody, PluginDataEntry, LOG_LEVEL, VER, PERIODIC_PLUGIN_SWEEP, DEFAULT_SETTINGS, PluginList, DevicePluginList } from "./types";
import { base64ToString, arrayBufferToBase64, base64ToArrayBuffer, isValidPath, versionNumberString2Number, id2path, path2id, runWithLock } from "./utils";
import { Logger, setLogger } from "./logger";
import { LocalPouchDB } from "./LocalPouchDB";
import { LogDisplayModal } from "./LogDisplayModal";
import { ConflictResolveModal } from "./ConflictResolveModal";
import { ObsidianLiveSyncSettingTab } from "./ObsidianLiveSyncSettingTab";

export default class ObsidianLiveSyncPlugin extends Plugin {
    settings: ObsidianLiveSyncSettings;
    localDatabase: LocalPouchDB;
    logMessage: string[] = [];
    statusBar: HTMLElement;
    statusBar2: HTMLElement;
    suspended: boolean;

    setInterval(handler: () => any, timeout?: number): number {
        const timer = window.setInterval(handler, timeout);
        this.registerInterval(timer);
        return timer;
    }
    async onload() {
        setLogger(this.addLog.bind(this)); // Logger moved to global.
        Logger("loading plugin");
        const lsname = "obsidian-live-sync-ver" + this.app.vault.getName();
        const last_version = localStorage.getItem(lsname);
        await this.loadSettings();
        if (!last_version || Number(last_version) < VER) {
            this.settings.liveSync = false;
            this.settings.syncOnSave = false;
            this.settings.syncOnStart = false;
            this.settings.syncOnFileOpen = false;
            this.settings.periodicReplication = false;
            this.settings.versionUpFlash = "I changed specifications incompatiblly, so when you enable sync again, be sure to made version up all nother devides.";
            this.saveSettings();
        }
        localStorage.setItem(lsname, `${VER}`);
        await this.openDatabase();

        addIcon(
            "replicate",
            `<g transform="matrix(1.15 0 0 1.15 -8.31 -9.52)" fill="currentColor" fill-rule="evenodd">
            <path d="m85 22.2c-0.799-4.74-4.99-8.37-9.88-8.37-0.499 0-1.1 0.101-1.6 0.101-2.4-3.03-6.09-4.94-10.3-4.94-6.09 0-11.2 4.14-12.8 9.79-5.59 1.11-9.78 6.05-9.78 12 0 6.76 5.39 12.2 12 12.2h29.9c5.79 0 10.1-4.74 10.1-10.6 0-4.84-3.29-8.88-7.68-10.2zm-2.99 14.7h-29.5c-2.3-0.202-4.29-1.51-5.29-3.53-0.899-2.12-0.699-4.54 0.698-6.46 1.2-1.61 2.99-2.52 4.89-2.52 0.299 0 0.698 0 0.998 0.101l1.8 0.303v-2.02c0-3.63 2.4-6.76 5.89-7.57 0.599-0.101 1.2-0.202 1.8-0.202 2.89 0 5.49 1.62 6.79 4.24l0.598 1.21 1.3-0.504c0.599-0.202 1.3-0.303 2-0.303 1.3 0 2.5 0.404 3.59 1.11 1.6 1.21 2.6 3.13 2.6 5.15v1.61h2c2.6 0 4.69 2.12 4.69 4.74-0.099 2.52-2.2 4.64-4.79 4.64z"/>
            <path d="m53.2 49.2h-41.6c-1.8 0-3.2 1.4-3.2 3.2v28.6c0 1.8 1.4 3.2 3.2 3.2h15.8v4h-7v6h24v-6h-7v-4h15.8c1.8 0 3.2-1.4 3.2-3.2v-28.6c0-1.8-1.4-3.2-3.2-3.2zm-2.8 29h-36v-23h36z"/>
            <path d="m73 49.2c1.02 1.29 1.53 2.97 1.53 4.56 0 2.97-1.74 5.65-4.39 7.04v-4.06l-7.46 7.33 7.46 7.14v-4.06c7.66-1.98 12.2-9.61 10-17-0.102-0.297-0.205-0.595-0.307-0.892z"/>
            <path d="m24.1 43c-0.817-0.991-1.53-2.97-1.53-4.56 0-2.97 1.74-5.65 4.39-7.04v4.06l7.46-7.33-7.46-7.14v4.06c-7.66 1.98-12.2 9.61-10 17 0.102 0.297 0.205 0.595 0.307 0.892z"/>
           </g>`
        );
        addIcon(
            "view-log",
            `<g transform="matrix(1.28 0 0 1.28 -131 -411)" fill="currentColor" fill-rule="evenodd">
        <path d="m103 330h76v12h-76z"/>
        <path d="m106 346v44h70v-44zm45 16h-20v-8h20z"/>
       </g>`
        );
        this.addRibbonIcon("replicate", "Replicate", async () => {
            await this.replicate(true);
        });

        this.addRibbonIcon("view-log", "Show log", () => {
            new LogDisplayModal(this.app, this).open();
        });

        this.statusBar = this.addStatusBarItem();
        this.statusBar.addClass("syncstatusbar");
        this.refreshStatusText = this.refreshStatusText.bind(this);

        this.statusBar2 = this.addStatusBarItem();
        // this.watchVaultChange = debounce(this.watchVaultChange.bind(this), delay, false);
        // this.watchVaultDelete = debounce(this.watchVaultDelete.bind(this), delay, false);
        // this.watchVaultRename = debounce(this.watchVaultRename.bind(this), delay, false);

        this.watchVaultChange = this.watchVaultChange.bind(this);
        this.watchVaultCreate = this.watchVaultCreate.bind(this);
        this.watchVaultDelete = this.watchVaultDelete.bind(this);
        this.watchVaultRename = this.watchVaultRename.bind(this);
        this.watchWorkspaceOpen = debounce(this.watchWorkspaceOpen.bind(this), 1000, false);
        this.watchWindowVisiblity = debounce(this.watchWindowVisiblity.bind(this), 1000, false);

        this.parseReplicationResult = this.parseReplicationResult.bind(this);

        this.periodicSync = this.periodicSync.bind(this);
        this.setPeriodicSync = this.setPeriodicSync.bind(this);

        // this.registerWatchEvents();
        this.addSettingTab(new ObsidianLiveSyncSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(async () => {
            try {
                await this.initializeDatabase();
                await this.realizeSettingSyncMode();
                this.registerWatchEvents();
                if (this.settings.syncOnStart) {
                    await this.localDatabase.openReplication(this.settings, false, false, this.parseReplicationResult);
                }
            } catch (ex) {
                Logger("Error while loading Self-hosted LiveSync", LOG_LEVEL.NOTICE);
                Logger(ex, LOG_LEVEL.VERBOSE);
            }
        });
        this.addCommand({
            id: "livesync-replicate",
            name: "Replicate now",
            callback: () => {
                this.replicate();
            },
        });
        this.addCommand({
            id: "livesync-dump",
            name: "Dump informations of this doc ",
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.localDatabase.disposeHashCache();
                this.localDatabase.getDBEntry(view.file.path, {}, true, false);
            },
        });
        this.addCommand({
            id: "livesync-gc",
            name: "garbage collect now",
            callback: () => {
                this.garbageCollect();
            },
        });
        this.addCommand({
            id: "livesync-toggle",
            name: "Toggle LiveSync",
            callback: async () => {
                if (this.settings.liveSync) {
                    this.settings.liveSync = false;
                    Logger("LiveSync Disabled.", LOG_LEVEL.NOTICE);
                } else {
                    this.settings.liveSync = true;
                    Logger("LiveSync Enabled.", LOG_LEVEL.NOTICE);
                }
                await this.realizeSettingSyncMode();
                this.saveSettings();
            },
        });
        this.addCommand({
            id: "livesync-suspendall",
            name: "Toggle All Sync.",
            callback: async () => {
                if (this.suspended) {
                    this.suspended = false;
                    Logger("Self-hosted LiveSync resumed", LOG_LEVEL.NOTICE);
                } else {
                    this.suspended = true;
                    Logger("Self-hosted LiveSync suspended", LOG_LEVEL.NOTICE);
                }
                await this.realizeSettingSyncMode();
                this.saveSettings();
            },
        });
        this.triggerRealizeSettingSyncMode = debounce(this.triggerRealizeSettingSyncMode.bind(this), 1000);
        this.triggerCheckPluginUpdate = debounce(this.triggerCheckPluginUpdate.bind(this), 3000);
    }
    onunload() {
        this.localDatabase.onunload();
        if (this.gcTimerHandler != null) {
            clearTimeout(this.gcTimerHandler);
            this.gcTimerHandler = null;
        }
        this.clearPeriodicSync();
        this.clearPluginSweep();
        this.localDatabase.closeReplication();
        this.localDatabase.close();
        window.removeEventListener("visibilitychange", this.watchWindowVisiblity);
        Logger("unloading plugin");
    }

    async openDatabase() {
        if (this.localDatabase != null) {
            this.localDatabase.close();
        }
        const vaultName = this.app.vault.getName();
        Logger("Open Database...");
        this.localDatabase = new LocalPouchDB(this.settings, vaultName);
        this.localDatabase.updateInfo = () => {
            this.refreshStatusText();
        };
        await this.localDatabase.initializeDatabase();
    }
    async garbageCollect() {
        await this.localDatabase.garbageCollect();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.settings.workingEncrypt = this.settings.encrypt;
        this.settings.workingPassphrase = this.settings.passphrase;
    }

    triggerRealizeSettingSyncMode() {
        (async () => await this.realizeSettingSyncMode())();
    }
    async saveSettings() {
        await this.saveData(this.settings);
        this.localDatabase.settings = this.settings;
        this.triggerRealizeSettingSyncMode();
    }
    gcTimerHandler: any = null;
    gcHook() {
        if (this.settings.gcDelay == 0) return;
        const GC_DELAY = this.settings.gcDelay * 1000; // if leaving opening window, try GC,
        if (this.gcTimerHandler != null) {
            clearTimeout(this.gcTimerHandler);
            this.gcTimerHandler = null;
        }
        this.gcTimerHandler = setTimeout(() => {
            this.gcTimerHandler = null;
            this.garbageCollect();
        }, GC_DELAY);
    }
    registerWatchEvents() {
        this.registerEvent(this.app.vault.on("modify", this.watchVaultChange));
        this.registerEvent(this.app.vault.on("delete", this.watchVaultDelete));
        this.registerEvent(this.app.vault.on("rename", this.watchVaultRename));
        this.registerEvent(this.app.vault.on("create", this.watchVaultChange));
        this.registerEvent(this.app.workspace.on("file-open", this.watchWorkspaceOpen));
        window.addEventListener("visibilitychange", this.watchWindowVisiblity);
    }

    watchWindowVisiblity() {
        this.watchWindowVisiblityAsync();
    }
    async watchWindowVisiblityAsync() {
        if (this.settings.suspendFileWatching) return;
        // if (this.suspended) return;
        const isHidden = document.hidden;
        await this.applyBatchChange();
        if (isHidden) {
            this.localDatabase.closeReplication();
            this.clearPeriodicSync();
        } else {
            // suspend all temporary.
            if (this.suspended) return;
            if (this.settings.autoSweepPlugins) {
                await this.sweepPlugin(false);
            }
            if (this.settings.liveSync) {
                await this.localDatabase.openReplication(this.settings, true, false, this.parseReplicationResult);
            }
            if (this.settings.syncOnStart) {
                await this.localDatabase.openReplication(this.settings, false, false, this.parseReplicationResult);
            }
            if (this.settings.periodicReplication) {
                this.setPeriodicSync();
            }
        }
        this.gcHook();
    }

    watchWorkspaceOpen(file: TFile) {
        if (this.settings.suspendFileWatching) return;
        this.watchWorkspaceOpenAsync(file);
    }
    async watchWorkspaceOpenAsync(file: TFile) {
        await this.applyBatchChange();
        if (file == null) return;
        if (this.settings.syncOnFileOpen && !this.suspended) {
            await this.replicate();
        }
        this.localDatabase.disposeHashCache();
        await this.showIfConflicted(file);
        this.gcHook();
    }
    watchVaultCreate(file: TFile, ...args: any[]) {
        if (this.settings.suspendFileWatching) return;
        this.watchVaultChangeAsync(file, ...args);
    }
    watchVaultChange(file: TAbstractFile, ...args: any[]) {
        if (!(file instanceof TFile)) {
            return;
        }
        if (this.settings.suspendFileWatching) return;
        // If batchsave is enabled, queue all changes and do nothing.
        if (this.settings.batchSave) {
            this.batchFileChange = Array.from(new Set([...this.batchFileChange, file.path]));
            this.refreshStatusText();
            return;
        }
        this.watchVaultChangeAsync(file, ...args);
    }
    async applyBatchChange() {
        return await runWithLock("batchSave", false, async () => {
            const batchItems = JSON.parse(JSON.stringify(this.batchFileChange)) as string[];
            this.batchFileChange = [];
            const files = this.app.vault.getFiles();
            const promises = batchItems.map(async (e) => {
                try {
                    if (await this.app.vault.adapter.exists(normalizePath(e))) {
                        const f = files.find((f) => f.path == e);
                        if (f) {
                            await this.updateIntoDB(f);
                            Logger(`Batch save:${e}`);
                        }
                    }
                } catch (ex) {
                    Logger(`Batch save error:${e}`, LOG_LEVEL.NOTICE);
                    Logger(ex, LOG_LEVEL.VERBOSE);
                }
            });
            this.refreshStatusText();
            return await Promise.all(promises);
        });
    }
    batchFileChange: string[] = [];
    async watchVaultChangeAsync(file: TFile, ...args: any[]) {
        if (file instanceof TFile) {
            await this.updateIntoDB(file);
            this.gcHook();
        }
    }
    watchVaultDelete(file: TAbstractFile) {
        // When save is delayed, it should be cancelled.
        this.batchFileChange = this.batchFileChange.filter((e) => e == file.path);
        if (this.settings.suspendFileWatching) return;
        this.watchVaultDeleteAsync(file);
    }
    async watchVaultDeleteAsync(file: TAbstractFile) {
        if (file instanceof TFile) {
            await this.deleteFromDB(file);
        } else if (file instanceof TFolder) {
            await this.deleteFolderOnDB(file);
        }
        this.gcHook();
    }
    GetAllFilesRecursively(file: TAbstractFile): TFile[] {
        if (file instanceof TFile) {
            return [file];
        } else if (file instanceof TFolder) {
            const result: TFile[] = [];
            for (const v of file.children) {
                result.push(...this.GetAllFilesRecursively(v));
            }
            return result;
        } else {
            Logger(`Filetype error:${file.path}`, LOG_LEVEL.NOTICE);
            throw new Error(`Filetype error:${file.path}`);
        }
    }
    watchVaultRename(file: TAbstractFile, oldFile: any) {
        if (this.settings.suspendFileWatching) return;
        this.watchVaultRenameAsync(file, oldFile);
    }
    getFilePath(file: TAbstractFile): string {
        if (file instanceof TFolder) {
            if (file.isRoot()) return "";
            return this.getFilePath(file.parent) + "/" + file.name;
        }
        if (file instanceof TFile) {
            return this.getFilePath(file.parent) + "/" + file.name;
        }

        return this.getFilePath(file.parent) + "/" + file.name;
    }
    async watchVaultRenameAsync(file: TAbstractFile, oldFile: any) {
        Logger(`${oldFile} renamed to ${file.path}`, LOG_LEVEL.VERBOSE);
        await this.applyBatchChange();
        if (file instanceof TFolder) {
            const newFiles = this.GetAllFilesRecursively(file);
            // for guard edge cases. this won't happen and each file's event will be raise.
            for (const i of newFiles) {
                const newFilePath = normalizePath(this.getFilePath(i));
                const newFile = this.app.vault.getAbstractFileByPath(newFilePath);
                if (newFile instanceof TFile) {
                    Logger(`save ${newFile.path} into db`);
                    await this.updateIntoDB(newFile);
                }
            }
            Logger(`delete below ${oldFile} from db`);
            await this.deleteFromDBbyPath(oldFile);
        } else if (file instanceof TFile) {
            Logger(`file save ${file.path} into db`);
            await this.updateIntoDB(file);
            Logger(`deleted ${oldFile} into db`);
            await this.deleteFromDBbyPath(oldFile);
        }
        this.gcHook();
    }
    addLogHook: () => void = null;
    //--> Basic document Functions
    notifies: { [key: string]: { notice: Notice; timer: NodeJS.Timeout; count: number } } = {};
    // eslint-disable-next-line require-await
    async addLog(message: any, level: LOG_LEVEL = LOG_LEVEL.INFO) {
        if (level < LOG_LEVEL.INFO && this.settings && this.settings.lessInformationInLog) {
            return;
        }
        if (this.settings && !this.settings.showVerboseLog && level == LOG_LEVEL.VERBOSE) {
            return;
        }
        const valutName = this.app.vault.getName();
        const timestamp = new Date().toLocaleString();
        const messagecontent = typeof message == "string" ? message : message instanceof Error ? `${message.name}:${message.message}` : JSON.stringify(message, null, 2);
        const newmessage = timestamp + "->" + messagecontent;

        this.logMessage = [].concat(this.logMessage).concat([newmessage]).slice(-100);
        console.log(valutName + ":" + newmessage);
        // if (this.statusBar2 != null) {
        //     this.statusBar2.setText(newmessage.substring(0, 60));
        // }

        if (level >= LOG_LEVEL.NOTICE) {
            if (messagecontent in this.notifies) {
                clearTimeout(this.notifies[messagecontent].timer);
                this.notifies[messagecontent].count++;
                this.notifies[messagecontent].notice.setMessage(`(${this.notifies[messagecontent].count}):${messagecontent}`);
                this.notifies[messagecontent].timer = setTimeout(() => {
                    const notify = this.notifies[messagecontent].notice;
                    delete this.notifies[messagecontent];
                    try {
                        notify.hide();
                    } catch (ex) {
                        // NO OP
                    }
                }, 5000);
            } else {
                const notify = new Notice(messagecontent, 0);
                this.notifies[messagecontent] = {
                    count: 0,
                    notice: notify,
                    timer: setTimeout(() => {
                        delete this.notifies[messagecontent];
                        notify.hide();
                    }, 5000),
                };
            }
        }
        if (this.addLogHook != null) this.addLogHook();
    }

    async ensureDirectory(fullpath: string) {
        const pathElements = fullpath.split("/");
        pathElements.pop();
        let c = "";
        for (const v of pathElements) {
            c += v;
            try {
                await this.app.vault.createFolder(c);
            } catch (ex) {
                // basically skip exceptions.
                if (ex.message && ex.message == "Folder already exists.") {
                    // especialy this message is.
                } else {
                    Logger("Folder Create Error");
                    Logger(ex);
                }
            }
            c += "/";
        }
    }

    async doc2storage_create(docEntry: EntryBody, force?: boolean) {
        const pathSrc = id2path(docEntry._id);
        const doc = await this.localDatabase.getDBEntry(pathSrc, { rev: docEntry._rev });
        if (doc === false) return;
        const path = id2path(doc._id);
        if (doc.datatype == "newnote") {
            const bin = base64ToArrayBuffer(doc.data);
            if (bin != null) {
                if (!isValidPath(path)) {
                    Logger(`The file that having platform dependent name has been arrived. This file has skipped: ${path}`, LOG_LEVEL.NOTICE);
                    return;
                }
                await this.ensureDirectory(path);
                try {
                    const newfile = await this.app.vault.createBinary(normalizePath(path), bin, { ctime: doc.ctime, mtime: doc.mtime });
                    Logger("live : write to local (newfile:b) " + path);
                    await this.app.vault.trigger("create", newfile);
                } catch (ex) {
                    Logger("could not write to local (newfile:bin) " + path, LOG_LEVEL.NOTICE);
                    Logger(ex, LOG_LEVEL.VERBOSE);
                }
            }
        } else if (doc.datatype == "plain") {
            if (!isValidPath(path)) {
                Logger(`The file that having platform dependent name has been arrived. This file has skipped: ${path}`, LOG_LEVEL.NOTICE);
                return;
            }
            await this.ensureDirectory(path);
            try {
                const newfile = await this.app.vault.create(normalizePath(path), doc.data, { ctime: doc.ctime, mtime: doc.mtime });
                Logger("live : write to local (newfile:p) " + path);
                await this.app.vault.trigger("create", newfile);
            } catch (ex) {
                Logger("could not write to local (newfile:plain) " + path, LOG_LEVEL.NOTICE);
                Logger(ex, LOG_LEVEL.VERBOSE);
            }
        } else {
            Logger("live : New data imcoming, but we cound't parse that." + doc.datatype, LOG_LEVEL.NOTICE);
        }
    }

    async deleteVaultItem(file: TFile | TFolder) {
        const dir = file.parent;
        if (this.settings.trashInsteadDelete) {
            await this.app.vault.trash(file, false);
        } else {
            await this.app.vault.delete(file);
        }
        Logger(`deleted:${file.path}`);
        Logger(`other items:${dir.children.length}`);
        if (dir.children.length == 0) {
            if (!this.settings.doNotDeleteFolder) {
                Logger(`all files deleted by replication, so delete dir`);
                await this.deleteVaultItem(dir);
            }
        }
    }
    async doc2storate_modify(docEntry: EntryBody, file: TFile, force?: boolean) {
        const pathSrc = id2path(docEntry._id);
        if (docEntry._deleted) {
            //basically pass.
            //but if there're no docs left, delete file.
            const lastDocs = await this.localDatabase.getDBEntry(pathSrc);
            if (lastDocs === false) {
                await this.deleteVaultItem(file);
            } else {
                // it perhaps delete some revisions.
                // may be we have to reload this
                await this.pullFile(pathSrc, null, true);
                Logger(`delete skipped:${lastDocs._id}`);
            }
            return;
        }
        const localMtime = ~~(file.stat.mtime / 1000);
        const docMtime = ~~(docEntry.mtime / 1000);
        if (localMtime < docMtime || force) {
            const doc = await this.localDatabase.getDBEntry(pathSrc);
            let msg = "livesync : newer local files so write to local:" + file.path;
            if (force) msg = "livesync : force write to local:" + file.path;
            if (doc === false) return;
            const path = id2path(doc._id);
            if (doc.datatype == "newnote") {
                const bin = base64ToArrayBuffer(doc.data);
                if (bin != null) {
                    if (!isValidPath(path)) {
                        Logger(`The file that having platform dependent name has been arrived. This file has skipped: ${path}`, LOG_LEVEL.NOTICE);
                        return;
                    }
                    await this.ensureDirectory(path);
                    try {
                        await this.app.vault.modifyBinary(file, bin, { ctime: doc.ctime, mtime: doc.mtime });
                        Logger(msg);
                        await this.app.vault.trigger("modify", file);
                    } catch (ex) {
                        Logger("could not write to local (modify:bin) " + path, LOG_LEVEL.NOTICE);
                    }
                }
            } else if (doc.datatype == "plain") {
                if (!isValidPath(path)) {
                    Logger(`The file that having platform dependent name has been arrived. This file has skipped: ${path}`, LOG_LEVEL.NOTICE);
                    return;
                }
                await this.ensureDirectory(path);
                try {
                    await this.app.vault.modify(file, doc.data, { ctime: doc.ctime, mtime: doc.mtime });
                    Logger(msg);
                    await this.app.vault.trigger("modify", file);
                } catch (ex) {
                    Logger("could not write to local (modify:plain) " + path, LOG_LEVEL.NOTICE);
                }
            } else {
                Logger("live : New data imcoming, but we cound't parse that.:" + doc.datatype + "-", LOG_LEVEL.NOTICE);
            }
        } else if (localMtime > docMtime) {
            // newer local file.
            // ?
        } else {
            //Nothing have to op.
            //eq.case
        }
    }
    async handleDBChanged(change: EntryBody) {
        const allfiles = this.app.vault.getFiles();
        const targetFiles = allfiles.filter((e) => e.path == id2path(change._id));
        if (targetFiles.length == 0) {
            if (change._deleted) {
                return;
            }
            const doc = change;
            await this.doc2storage_create(doc);
        }
        if (targetFiles.length == 1) {
            const doc = change;
            const file = targetFiles[0];
            await this.doc2storate_modify(doc, file);
            await this.showIfConflicted(file);
        }
    }

    periodicSyncHandler: number = null;
    //---> Sync
    async parseReplicationResult(docs: Array<PouchDB.Core.ExistingDocument<EntryDoc>>): Promise<void> {
        this.refreshStatusText();
        for (const change of docs) {
            if (change._id.startsWith("ps:")) {
                if (this.settings.notifyPluginOrSettingUpdated) {
                    this.triggerCheckPluginUpdate();
                }
                continue;
            }
            if (change._id.startsWith("h:")) {
                continue;
            }
            if (change.type != "leaf" && change.type != "versioninfo" && change.type != "milestoneinfo" && change.type != "nodeinfo") {
                Logger("replication change arrived", LOG_LEVEL.VERBOSE);
                await this.handleDBChanged(change);
            }
            if (change.type == "versioninfo") {
                if (change.version > VER) {
                    this.localDatabase.closeReplication();
                    Logger(`Remote database updated to incompatible version. update your self-hosted-livesync plugin.`, LOG_LEVEL.NOTICE);
                }
            }
            this.gcHook();
        }
    }
    triggerCheckPluginUpdate() {
        (async () => await this.checkPluginUpdate())();
    }
    async checkPluginUpdate() {
        if (!this.settings.usePluginSync) return;
        await this.sweepPlugin(false);
        const { allPlugins, thisDevicePlugins } = await this.getPluginList();
        const arrPlugins = Object.values(allPlugins);
        for (const plugin of arrPlugins) {
            const currentPlugin = thisDevicePlugins[plugin.manifest.id];
            if (currentPlugin) {
                const thisVersion = versionNumberString2Number(plugin.manifest.version);
                const currentVersion = versionNumberString2Number(currentPlugin.manifest.version);
                if (thisVersion > currentVersion) {
                    Logger(`the device ${plugin.deviceVaultName} has the newer plugin:${plugin.manifest.name}`, LOG_LEVEL.NOTICE);
                }
                if (plugin.mtime > currentPlugin.mtime) {
                    Logger(`the device ${plugin.deviceVaultName} has the newer settings of the plugin:${plugin.manifest.name}`, LOG_LEVEL.NOTICE);
                }
            } else {
                Logger(`the device ${plugin.deviceVaultName} has the new plugin:${plugin.manifest.name}`, LOG_LEVEL.NOTICE);
            }
        }
    }
    clearPeriodicSync() {
        if (this.periodicSyncHandler != null) {
            clearInterval(this.periodicSyncHandler);
            this.periodicSyncHandler = null;
        }
    }
    setPeriodicSync() {
        if (this.settings.periodicReplication && this.settings.periodicReplicationInterval > 0) {
            this.clearPeriodicSync();
            this.periodicSyncHandler = this.setInterval(async () => await this.periodicSync(), Math.max(this.settings.periodicReplicationInterval, 30) * 1000);
        }
    }
    async periodicSync() {
        await this.replicate();
    }
    periodicPluginSweepHandler: number = null;
    clearPluginSweep() {
        if (this.periodicPluginSweepHandler != null) {
            clearInterval(this.periodicPluginSweepHandler);
            this.periodicPluginSweepHandler = null;
        }
    }
    setPluginSweep() {
        if (this.settings.autoSweepPluginsPeriodic) {
            this.clearPluginSweep();
            this.periodicPluginSweepHandler = this.setInterval(async () => await this.periodicPluginSweep(), PERIODIC_PLUGIN_SWEEP * 1000);
        }
    }
    async periodicPluginSweep() {
        await this.sweepPlugin(false);
    }
    async realizeSettingSyncMode() {
        this.localDatabase.closeReplication();
        this.clearPeriodicSync();
        this.clearPluginSweep();
        await this.applyBatchChange();
        // disable all sync temporary.
        if (this.suspended) return;
        if (this.settings.autoSweepPlugins) {
            await this.sweepPlugin(false);
        }
        if (this.settings.liveSync) {
            await this.localDatabase.openReplication(this.settings, true, false, this.parseReplicationResult);
            this.refreshStatusText();
        }
        this.setPeriodicSync();
        this.setPluginSweep();
    }
    lastMessage = "";
    refreshStatusText() {
        const sent = this.localDatabase.docSent;
        const arrived = this.localDatabase.docArrived;
        let w = "";
        switch (this.localDatabase.syncStatus) {
            case "CLOSED":
            case "COMPLETED":
            case "NOT_CONNECTED":
                w = "⏹";
                break;
            case "STARTED":
                w = "🌀";
                break;
            case "PAUSED":
                w = "💤";
                break;
            case "CONNECTED":
                w = "⚡";
                break;
            case "ERRORED":
                w = "⚠";
                break;
            default:
                w = "?";
        }
        this.statusBar.title = this.localDatabase.syncStatus;
        let waiting = "";
        if (this.settings.batchSave) {
            waiting = " " + this.batchFileChange.map((e) => "🛫").join("");
            waiting = waiting.replace(/🛫{10}/g, "🚀");
        }
        const message = `Sync:${w} ↑${sent} ↓${arrived}${waiting}`;
        this.setStatusBarText(message);
    }
    setStatusBarText(message: string) {
        if (this.lastMessage != message) {
            this.statusBar.setText(message);
            if (this.settings.showStatusOnEditor) {
                const root = document.documentElement;
                root.style.setProperty("--slsmessage", '"' + message + '"');
            } else {
                const root = document.documentElement;
                root.style.setProperty("--slsmessage", '""');
            }
            this.lastMessage = message;
        }
    }
    async replicate(showMessage?: boolean) {
        if (this.settings.versionUpFlash != "") {
            new Notice("Open settings and check message, please.");
            return;
        }
        await this.applyBatchChange();
        if (this.settings.autoSweepPlugins) {
            await this.sweepPlugin(false);
        }
        await this.localDatabase.openReplication(this.settings, false, showMessage, this.parseReplicationResult);
    }

    async initializeDatabase(showingNotice?: boolean) {
        await this.openDatabase();
        await this.syncAllFiles(showingNotice);
    }
    async replicateAllToServer(showingNotice?: boolean) {
        if (this.settings.autoSweepPlugins) {
            await this.sweepPlugin(showingNotice);
        }
        return await this.localDatabase.replicateAllToServer(this.settings, showingNotice);
    }
    async markRemoteLocked() {
        return await this.localDatabase.markRemoteLocked(this.settings, true);
    }
    async markRemoteUnlocked() {
        return await this.localDatabase.markRemoteLocked(this.settings, false);
    }
    async markRemoteResolved() {
        return await this.localDatabase.markRemoteResolved(this.settings);
    }
    async syncAllFiles(showingNotice?: boolean) {
        // synchronize all files between database and storage.
        let notice: Notice = null;
        if (showingNotice) {
            notice = new Notice("Initializing", 0);
        }
        const filesStorage = this.app.vault.getFiles();
        const filesStorageName = filesStorage.map((e) => e.path);
        const wf = await this.localDatabase.localDatabase.allDocs();
        const filesDatabase = wf.rows.filter((e) => !e.id.startsWith("h:") && !e.id.startsWith("ps:") && e.id != "obsydian_livesync_version").map((e) => id2path(e.id));

        const onlyInStorage = filesStorage.filter((e) => filesDatabase.indexOf(e.path) == -1);
        const onlyInDatabase = filesDatabase.filter((e) => filesStorageName.indexOf(e) == -1);

        const onlyInStorageNames = onlyInStorage.map((e) => e.path);

        const syncFiles = filesStorage.filter((e) => onlyInStorageNames.indexOf(e.path) == -1);
        Logger("Initialize and checking database files");
        Logger("Updating database by new files");
        this.setStatusBarText(`UPDATE DATABASE`);

        const runAll = async <T>(procedurename: string, objects: T[], callback: (arg: T) => Promise<void>) => {
            const count = objects.length;
            Logger(procedurename);
            let i = 0;
            // let lastTicks = performance.now() + 2000;
            const procs = objects.map(async (e) => {
                try {
                    await callback(e);
                    i++;
                    if (i % 25 == 0) {
                        const notify = `${procedurename} : ${i}/${count}`;
                        if (notice != null) notice.setMessage(notify);
                        Logger(notify);
                        this.setStatusBarText(notify);
                    }
                } catch (ex) {
                    Logger(`Error while ${procedurename}`, LOG_LEVEL.NOTICE);
                    Logger(ex);
                }
            });
            if (!Promise.allSettled) {
                await Promise.all(
                    procs.map((p) =>
                        p
                            .then((value) => ({
                                status: "fulfilled",
                                value,
                            }))
                            .catch((reason) => ({
                                status: "rejected",
                                reason,
                            }))
                    )
                );
            } else {
                await Promise.allSettled(procs);
            }
        };
        await runAll("UPDATE DATABASE", onlyInStorage, async (e) => {
            Logger(`Update into ${e.path}`);
            await this.updateIntoDB(e);
        });
        await runAll("UPDATE STORAGE", onlyInDatabase, async (e) => {
            Logger(`Pull from db:${e}`);
            await this.pullFile(e, filesStorage, false, null, false);
        });
        await runAll("CHECK FILE STATUS", syncFiles, async (e) => {
            await this.syncFileBetweenDBandStorage(e, filesStorage);
        });
        this.setStatusBarText(`NOW TRACKING!`);
        Logger("Initialized,NOW TRACKING!");
        if (showingNotice) {
            notice.hide();
            Logger("Initialize done!", LOG_LEVEL.NOTICE);
        }
    }
    async deleteFolderOnDB(folder: TFolder) {
        Logger(`delete folder:${folder.path}`);
        await this.localDatabase.deleteDBEntryPrefix(folder.path + "/");
        for (const v of folder.children) {
            const entry = v as TFile & TFolder;
            Logger(`->entry:${entry.path}`, LOG_LEVEL.VERBOSE);
            if (entry.children) {
                Logger(`->is dir`, LOG_LEVEL.VERBOSE);
                await this.deleteFolderOnDB(entry);
                try {
                    if (this.settings.trashInsteadDelete) {
                        await this.app.vault.trash(entry, false);
                    } else {
                        await this.app.vault.delete(entry);
                    }
                } catch (ex) {
                    if (ex.code && ex.code == "ENOENT") {
                        //NO OP.
                    } else {
                        Logger(`error while delete folder:${entry.path}`, LOG_LEVEL.NOTICE);
                        Logger(ex);
                    }
                }
            } else {
                Logger(`->is file`, LOG_LEVEL.VERBOSE);
                await this.deleteFromDB(entry);
            }
        }
        try {
            if (this.settings.trashInsteadDelete) {
                await this.app.vault.trash(folder, false);
            } else {
                await this.app.vault.delete(folder);
            }
        } catch (ex) {
            if (ex.code && ex.code == "ENOENT") {
                //NO OP.
            } else {
                Logger(`error while delete filder:${folder.path}`, LOG_LEVEL.NOTICE);
                Logger(ex);
            }
        }
    }

    async renameFolder(folder: TFolder, oldFile: any) {
        for (const v of folder.children) {
            const entry = v as TFile & TFolder;
            if (entry.children) {
                await this.deleteFolderOnDB(entry);
                if (this.settings.trashInsteadDelete) {
                    await this.app.vault.trash(entry, false);
                } else {
                    await this.app.vault.delete(entry);
                }
            } else {
                await this.deleteFromDB(entry);
            }
        }
    }

    // --> conflict resolving
    async getConflictedDoc(path: string, rev: string): Promise<false | diff_result_leaf> {
        try {
            const doc = await this.localDatabase.getDBEntry(path, { rev: rev });
            if (doc === false) return false;
            let data = doc.data;
            if (doc.datatype == "newnote") {
                data = base64ToString(doc.data);
            } else if (doc.datatype == "plain") {
                data = doc.data;
            }
            return {
                ctime: doc.ctime,
                mtime: doc.mtime,
                rev: rev,
                data: data,
            };
        } catch (ex) {
            if (ex.status && ex.status == 404) {
                return false;
            }
        }
        return false;
    }
    /**
     * Getting file conflicted status.
     * @param path the file location
     * @returns true -> resolved, false -> nothing to do, or check result.
     */
    async getConflictedStatus(path: string): Promise<diff_check_result> {
        const test = await this.localDatabase.getDBEntry(path, { conflicts: true });
        if (test === false) return false;
        if (test == null) return false;
        if (!test._conflicts) return false;
        if (test._conflicts.length == 0) return false;
        // should be one or more conflicts;
        const leftLeaf = await this.getConflictedDoc(path, test._rev);
        const rightLeaf = await this.getConflictedDoc(path, test._conflicts[0]);
        if (leftLeaf == false) {
            // what's going on..
            Logger(`could not get current revisions:${path}`, LOG_LEVEL.NOTICE);
            return false;
        }
        if (rightLeaf == false) {
            // Conflicted item could not load, delete this.
            await this.localDatabase.deleteDBEntry(path, { rev: test._conflicts[0] });
            await this.pullFile(path, null, true);
            Logger(`could not get old revisions, automaticaly used newer one:${path}`, LOG_LEVEL.NOTICE);
            return true;
        }
        // first,check for same contents
        if (leftLeaf.data == rightLeaf.data) {
            let leaf = leftLeaf;
            if (leftLeaf.mtime > rightLeaf.mtime) {
                leaf = rightLeaf;
            }
            await this.localDatabase.deleteDBEntry(path, { rev: leaf.rev });
            await this.pullFile(path, null, true);
            Logger(`automaticaly merged:${path}`);
            return true;
        }
        if (this.settings.resolveConflictsByNewerFile) {
            const lmtime = ~~(leftLeaf.mtime / 1000);
            const rmtime = ~~(rightLeaf.mtime / 1000);
            let loser = leftLeaf;
            if (lmtime > rmtime) {
                loser = rightLeaf;
            }
            await this.localDatabase.deleteDBEntry(path, { rev: loser.rev });
            await this.pullFile(path, null, true);
            Logger(`Automaticaly merged (newerFileResolve) :${path}`, LOG_LEVEL.NOTICE);
            return true;
        }
        // make diff.
        const dmp = new diff_match_patch();
        const diff = dmp.diff_main(leftLeaf.data, rightLeaf.data);
        dmp.diff_cleanupSemantic(diff);
        Logger(`conflict(s) found:${path}`);
        return {
            left: leftLeaf,
            right: rightLeaf,
            diff: diff,
        };
    }
    async showIfConflicted(file: TFile) {
        await runWithLock("conflicted", false, async () => {
            const conflictCheckResult = await this.getConflictedStatus(file.path);
            if (conflictCheckResult === false) return; //nothign to do.
            if (conflictCheckResult === true) {
                //auto resolved, but need check again;
                setTimeout(() => {
                    this.showIfConflicted(file);
                }, 500);
                return;
            }
            //there conflicts, and have to resolve ;
            const leaf = this.app.workspace.activeLeaf;
            if (leaf) {
                new ConflictResolveModal(this.app, conflictCheckResult, async (selected) => {
                    const testDoc = await this.localDatabase.getDBEntry(file.path, { conflicts: true });
                    if (testDoc === false) return;
                    if (!testDoc._conflicts) {
                        Logger("something went wrong on merging.", LOG_LEVEL.NOTICE);
                        return;
                    }
                    const toDelete = selected;
                    if (toDelete == null) {
                        //concat both,
                        // write data,and delete both old rev.
                        const p = conflictCheckResult.diff.map((e) => e[1]).join("");
                        await this.app.vault.modify(file, p);
                        await this.localDatabase.deleteDBEntry(file.path, { rev: conflictCheckResult.left.rev });
                        await this.localDatabase.deleteDBEntry(file.path, { rev: conflictCheckResult.right.rev });
                        return;
                    }
                    if (toDelete == "") {
                        return;
                    }
                    Logger(`resolved conflict:${file.path}`);
                    await this.localDatabase.deleteDBEntry(file.path, { rev: toDelete });
                    await this.pullFile(file.path, null, true);
                    setTimeout(() => {
                        //resolved, check again.
                        this.showIfConflicted(file);
                    }, 500);
                }).open();
            }
        });
    }
    async pullFile(filename: string, fileList?: TFile[], force?: boolean, rev?: string, waitForReady = true) {
        if (!fileList) {
            fileList = this.app.vault.getFiles();
        }
        const targetFiles = fileList.filter((e) => e.path == id2path(filename));
        if (targetFiles.length == 0) {
            //have to create;
            const doc = await this.localDatabase.getDBEntry(filename, rev ? { rev: rev } : null, false, waitForReady);
            if (doc === false) return;
            await this.doc2storage_create(doc, force);
        } else if (targetFiles.length == 1) {
            //normal case
            const file = targetFiles[0];
            const doc = await this.localDatabase.getDBEntry(filename, rev ? { rev: rev } : null, false, waitForReady);
            if (doc === false) return;
            await this.doc2storate_modify(doc, file, force);
        } else {
            Logger(`target files:${filename} is two or more files in your vault`);
            //something went wrong..
        }
        //when to opened file;
    }
    async syncFileBetweenDBandStorage(file: TFile, fileList?: TFile[]) {
        const doc = await this.localDatabase.getDBEntryMeta(file.path);
        if (doc === false) return;

        const storageMtime = ~~(file.stat.mtime / 1000);
        const docMtime = ~~(doc.mtime / 1000);
        if (storageMtime > docMtime) {
            //newer local file.
            Logger("STORAGE -> DB :" + file.path);
            Logger(`${storageMtime} > ${docMtime}`);
            await this.updateIntoDB(file);
        } else if (storageMtime < docMtime) {
            //newer database file.
            Logger("STORAGE <- DB :" + file.path);
            Logger(`${storageMtime} < ${docMtime}`);
            const docx = await this.localDatabase.getDBEntry(file.path, null, false, false);
            if (docx != false) {
                await this.doc2storate_modify(docx, file);
            }
        } else {
            // Logger("EVEN :" + file.path, LOG_LEVEL.VERBOSE);
            // Logger(`${storageMtime} = ${docMtime}`, LOG_LEVEL.VERBOSE);
            //eq.case
        }
    }

    async updateIntoDB(file: TFile) {
        await this.localDatabase.waitForGCComplete();
        let content = "";
        let datatype: "plain" | "newnote" = "newnote";
        if (file.extension != "md") {
            const contentBin = await this.app.vault.readBinary(file);
            content = await arrayBufferToBase64(contentBin);
            datatype = "newnote";
        } else {
            content = await this.app.vault.read(file);
            datatype = "plain";
        }
        const fullpath = path2id(file.path);
        const d: LoadedEntry = {
            _id: fullpath,
            data: content,
            ctime: file.stat.ctime,
            mtime: file.stat.mtime,
            size: file.stat.size,
            children: [],
            datatype: datatype,
        };
        //From here
        const old = await this.localDatabase.getDBEntry(fullpath, null, false, false);
        if (old !== false) {
            const oldData = { data: old.data, deleted: old._deleted };
            const newData = { data: d.data, deleted: d._deleted };
            if (JSON.stringify(oldData) == JSON.stringify(newData)) {
                Logger("not changed:" + fullpath + (d._deleted ? " (deleted)" : ""), LOG_LEVEL.VERBOSE);
                return;
            }
            // d._rev = old._rev;
        }
        await this.localDatabase.putDBEntry(d);

        Logger("put database:" + fullpath + "(" + datatype + ") ");
        if (this.settings.syncOnSave && !this.suspended) {
            await this.replicate();
        }
    }
    async deleteFromDB(file: TFile) {
        const fullpath = file.path;
        Logger(`deleteDB By path:${fullpath}`);
        await this.deleteFromDBbyPath(fullpath);
        if (this.settings.syncOnSave && !this.suspended) {
            await this.replicate();
        }
    }
    async deleteFromDBbyPath(fullpath: string) {
        await this.localDatabase.deleteDBEntry(fullpath);
        if (this.settings.syncOnSave && !this.suspended) {
            await this.replicate();
        }
    }

    async resetLocalDatabase() {
        await this.localDatabase.resetDatabase();
    }
    async tryResetRemoteDatabase() {
        await this.localDatabase.tryResetRemoteDatabase(this.settings);
    }
    async tryCreateRemoteDatabase() {
        await this.localDatabase.tryCreateRemoteDatabase(this.settings);
    }
    async getPluginList(): Promise<{ plugins: PluginList; allPlugins: DevicePluginList; thisDevicePlugins: DevicePluginList }> {
        const db = this.localDatabase.localDatabase;
        const docList = await db.allDocs<PluginDataEntry>({ startkey: `ps:`, endkey: `ps;`, include_docs: false });
        const oldDocs: PluginDataEntry[] = ((await Promise.all(docList.rows.map(async (e) => await this.localDatabase.getDBEntry(e.id)))).filter((e) => e !== false) as LoadedEntry[]).map((e) => JSON.parse(e.data));
        const plugins: { [key: string]: PluginDataEntry[] } = {};
        const allPlugins: { [key: string]: PluginDataEntry } = {};
        const thisDevicePlugins: { [key: string]: PluginDataEntry } = {};
        for (const v of oldDocs) {
            if (typeof plugins[v.deviceVaultName] === "undefined") {
                plugins[v.deviceVaultName] = [];
            }
            plugins[v.deviceVaultName].push(v);
            allPlugins[v._id] = v;
            if (v.deviceVaultName == this.settings.deviceAndVaultName) {
                thisDevicePlugins[v.manifest.id] = v;
            }
        }
        return { plugins, allPlugins, thisDevicePlugins };
    }
    async sweepPlugin(showMessage = false) {
        console.log(`pluginSync:${this.settings.usePluginSync}`);
        if (!this.settings.usePluginSync) return;
        await runWithLock("sweepplugin", false, async () => {
            const logLevel = showMessage ? LOG_LEVEL.NOTICE : LOG_LEVEL.INFO;
            if (!this.settings.encrypt) {
                Logger("You have to encrypt the database to use plugin setting sync.", LOG_LEVEL.NOTICE);
                return;
            }
            if (!this.settings.deviceAndVaultName) {
                Logger("You have to set your device and vault name.", LOG_LEVEL.NOTICE);
                return;
            }
            Logger("Sweeping plugins", logLevel);
            const db = this.localDatabase.localDatabase;
            const oldDocs = await db.allDocs({ startkey: `ps:${this.settings.deviceAndVaultName}-`, endkey: `ps:${this.settings.deviceAndVaultName}.`, include_docs: true });
            Logger("OLD DOCS.", LOG_LEVEL.VERBOSE);
            // sweep current plugin.
            // @ts-ignore
            const pl = this.app.plugins;
            const manifests: PluginManifest[] = Object.values(pl.manifests);
            for (const m of manifests) {
                Logger(`Reading plugin:${m.name}(${m.id})`, LOG_LEVEL.VERBOSE);
                const path = normalizePath(m.dir) + "/";
                const adapter = this.app.vault.adapter;
                const files = ["manifest.json", "main.js", "styles.css", "data.json"];
                const pluginData: { [key: string]: string } = {};
                for (const file of files) {
                    const thePath = path + file;
                    if (await adapter.exists(thePath)) {
                        pluginData[file] = await adapter.read(thePath);
                    }
                }
                let mtime = 0;
                if (await adapter.exists(path + "/data.json")) {
                    mtime = (await adapter.stat(path + "/data.json")).mtime;
                }
                const p: PluginDataEntry = {
                    _id: `ps:${this.settings.deviceAndVaultName}-${m.id}`,
                    dataJson: pluginData["data.json"],
                    deviceVaultName: this.settings.deviceAndVaultName,
                    mainJs: pluginData["main.js"],
                    styleCss: pluginData["styles.css"],
                    manifest: m,
                    manifestJson: pluginData["manifest.json"],
                    mtime: mtime,
                    type: "plugin",
                };
                const d: LoadedEntry = {
                    _id: p._id,
                    data: JSON.stringify(p),
                    ctime: mtime,
                    mtime: mtime,
                    size: 0,
                    children: [],
                    datatype: "plain",
                };
                Logger(`check diff:${m.name}(${m.id})`, LOG_LEVEL.VERBOSE);
                await runWithLock("plugin-" + m.id, false, async () => {
                    const old = await this.localDatabase.getDBEntry(p._id, null, false, false);
                    if (old !== false) {
                        const oldData = { data: old.data, deleted: old._deleted };
                        const newData = { data: d.data, deleted: d._deleted };
                        if (JSON.stringify(oldData) == JSON.stringify(newData)) {
                            oldDocs.rows = oldDocs.rows.filter((e) => e.id != d._id);
                            Logger(`Nothing changed:${m.name}`);
                            return;
                        }
                    }
                    await this.localDatabase.putDBEntry(d);
                    oldDocs.rows = oldDocs.rows.filter((e) => e.id != d._id);
                    Logger(`Plugin saved:${m.name}`, logLevel);
                });
                //remove saved plugin data.
            }
            Logger(`Deleting old plugins`, LOG_LEVEL.VERBOSE);
            const delDocs = oldDocs.rows.map((e) => {
                e.doc._deleted = true;
                return e.doc;
            });
            await db.bulkDocs(delDocs);
            Logger(`Sweep plugin done.`, logLevel);
        });
    }
    async applyPluginData(plugin: PluginDataEntry) {
        await runWithLock("plugin-" + plugin.manifest.id, false, async () => {
            const pluginTargetFolderPath = normalizePath(plugin.manifest.dir) + "/";
            const adapter = this.app.vault.adapter;
            // @ts-ignore
            const stat = this.app.plugins.enabledPlugins[plugin.manifest.id];
            if (stat) {
                // @ts-ignore
                await this.app.plugins.unloadPlugin(plugin.manifest.id);
                Logger(`Unload plugin:${plugin.manifest.id}`, LOG_LEVEL.NOTICE);
            }
            if (plugin.dataJson) await adapter.write(pluginTargetFolderPath + "data.json", plugin.dataJson);
            Logger("wrote:" + pluginTargetFolderPath + "data.json", LOG_LEVEL.NOTICE);
            // @ts-ignore
            if (stat) {
                // @ts-ignore
                await this.app.plugins.loadPlugin(plugin.manifest.id);
                Logger(`Load plugin:${plugin.manifest.id}`, LOG_LEVEL.NOTICE);
            }
        });
    }
    async applyPlugin(plugin: PluginDataEntry) {
        await runWithLock("plugin-" + plugin.manifest.id, false, async () => {
            // @ts-ignore
            const stat = this.app.plugins.enabledPlugins[plugin.manifest.id];
            if (stat) {
                // @ts-ignore
                await this.app.plugins.unloadPlugin(plugin.manifest.id);
                Logger(`Unload plugin:${plugin.manifest.id}`, LOG_LEVEL.NOTICE);
            }

            const pluginTargetFolderPath = normalizePath(plugin.manifest.dir) + "/";
            const adapter = this.app.vault.adapter;
            if ((await adapter.exists(pluginTargetFolderPath)) === false) {
                await adapter.mkdir(pluginTargetFolderPath);
            }
            await adapter.write(pluginTargetFolderPath + "main.js", plugin.mainJs);
            await adapter.write(pluginTargetFolderPath + "manifest.json", plugin.manifestJson);
            if (plugin.styleCss) await adapter.write(pluginTargetFolderPath + "styles.css", plugin.styleCss);
            // if (plugin.dataJson) await adapter.write(pluginTargetFolderPath + "data.json", plugin.dataJson);
            if (stat) {
                // @ts-ignore
                await this.app.plugins.loadPlugin(plugin.manifest.id);
                Logger(`Load plugin:${plugin.manifest.id}`, LOG_LEVEL.NOTICE);
            }
        });
    }
}
