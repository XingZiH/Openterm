import fs from 'fs/promises'
import { createReadStream, createWriteStream } from 'fs'
import path from 'path'
import os from 'os'
import { SFTPFile, createParentDirectoryEntry, sortSftpFiles } from '../shared/sftp-file'

// 并发 stat 上限，防止打开过多文件描述符
const STAT_CONCURRENCY = 64
export const MAX_EDIT_FILE_SIZE = 5 * 1024 * 1024 // 5MB 编辑上限
const BINARY_DETECT_BYTES = 8 * 1024 // 8KB 二进制探测窗口

export class LocalFileManager {
  async ls(targetPath: string): Promise<SFTPFile[]> {
    const actualPath = targetPath === '.' || !targetPath ? os.homedir() : targetPath

    let list
    try {
      list = await fs.readdir(actualPath, { withFileTypes: true })
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(`目录不存在: ${actualPath}`)
      }
      throw err
    }

    const results: SFTPFile[] = []
    for (let i = 0; i < list.length; i += STAT_CONCURRENCY) {
      const batch = list.slice(i, i + STAT_CONCURRENCY)
      const batchResults = await Promise.all(batch.map(async (dirent): Promise<SFTPFile | null> => {
        const fullPath = path.join(actualPath, dirent.name)
        try {
          const stat = await fs.stat(fullPath)
          const isDir = dirent.isDirectory()
          const isSymlink = dirent.isSymbolicLink()
          return {
            name: dirent.name,
            type: isDir ? 'd' : isSymlink ? 'l' : '-',
            size: stat.size,
            modifyTime: Math.floor(stat.mtimeMs / 1000),
            accessTime: Math.floor(stat.atimeMs / 1000),
            permissions: this.modeToPermissions(stat.mode, isDir, isSymlink)
          }
        } catch {
          return null
        }
      }))
      for (const result of batchResults) {
        if (result) results.push(result)
      }
    }

    const files = sortSftpFiles(results)
    const parentPath = path.dirname(actualPath)
    if (parentPath !== actualPath) {
      files.unshift(createParentDirectoryEntry())
    }

    return files
  }

  async download(remotePath: string, localPath: string, onProgress?: (transferred: number, total: number) => void): Promise<void> {
    if (onProgress) {
      const stat = await fs.stat(remotePath)
      const total = stat.size
      let transferred = 0
      return new Promise((resolve, reject) => {
        const rs = createReadStream(remotePath)
        const ws = createWriteStream(localPath)
        rs.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          onProgress(transferred, total)
        })
        rs.on('error', (err) => { ws.destroy(); reject(err) })
        ws.on('error', (err) => { rs.destroy(); reject(err) })
        ws.on('close', () => resolve())
        rs.pipe(ws)
      })
    }
    await fs.copyFile(remotePath, localPath)
  }

  async upload(localPath: string, remotePath: string, onProgress?: (transferred: number, total: number) => void): Promise<void> {
    if (onProgress) {
      const stat = await fs.stat(localPath)
      const total = stat.size
      let transferred = 0
      return new Promise((resolve, reject) => {
        const rs = createReadStream(localPath)
        const ws = createWriteStream(remotePath)
        rs.on('data', (chunk: Buffer) => {
          transferred += chunk.length
          onProgress(transferred, total)
        })
        rs.on('error', (err) => { ws.destroy(); reject(err) })
        ws.on('error', (err) => { rs.destroy(); reject(err) })
        ws.on('close', () => resolve())
        rs.pipe(ws)
      })
    }
    await fs.copyFile(localPath, remotePath)
  }

  async move(srcPath: string, destPath: string): Promise<void> {
    await fs.rename(srcPath, destPath)
  }

  async copy(srcPath: string, destPath: string): Promise<void> {
    const stat = await fs.stat(srcPath)
    if (stat.isDirectory()) {
      await fs.cp(srcPath, destPath, { recursive: true })
      return
    }
    await fs.copyFile(srcPath, destPath)
  }

  async readFile(filePath: string): Promise<{ content: string; size: number }> {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_EDIT_FILE_SIZE) {
      throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，编辑上限为 5MB`)
    }

    if (stat.size > 0) {
      const fileHandle = await fs.open(filePath, 'r')
      try {
        const probeSize = Math.min(stat.size, BINARY_DETECT_BYTES)
        const probeBuffer = Buffer.alloc(probeSize)
        const { bytesRead } = await fileHandle.read(probeBuffer, 0, probeSize, 0)
        for (let i = 0; i < bytesRead; i++) {
          if (probeBuffer[i] === 0) {
            throw new Error('这是一个二进制文件，不支持编辑')
          }
        }
      } finally {
        await fileHandle.close()
      }
    }

    const content = await fs.readFile(filePath, 'utf-8')
    return { content, size: stat.size }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.writeFile(filePath, content, 'utf-8')
  }

  private modeToPermissions(mode: number, isDir: boolean, isSymlink: boolean): string {
    const type = isDir ? 'd' : isSymlink ? 'l' : '-'
    const owner = (mode & 0o400 ? 'r' : '-') + (mode & 0o200 ? 'w' : '-') + (mode & 0o100 ? 'x' : '-')
    const group = (mode & 0o040 ? 'r' : '-') + (mode & 0o020 ? 'w' : '-') + (mode & 0o010 ? 'x' : '-')
    const others = (mode & 0o004 ? 'r' : '-') + (mode & 0o002 ? 'w' : '-') + (mode & 0o001 ? 'x' : '-')
    return type + owner + group + others
  }
}

export const localFileManager = new LocalFileManager()
