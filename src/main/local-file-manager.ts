import fs from 'fs/promises'
import path from 'path'
import os from 'os'

export class LocalFileManager {
  async ls(targetPath: string): Promise<any[]> {
    // resolve path if empty (use os.homedir())
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
    
    // gather stats
    const files = await Promise.all(list.map(async (dirent) => {
      const fullPath = path.join(actualPath, dirent.name)
      try {
        const stat = await fs.stat(fullPath)
        const isDir = dirent.isDirectory()
        const isSymlink = dirent.isSymbolicLink()
        const type = isDir ? 'd' : isSymlink ? 'l' : '-'
        
        const permissions = this.modeToPermissions(stat.mode, isDir, isSymlink)

        return {
          name: dirent.name,
          type,
          size: stat.size,
          modifyTime: Math.floor(stat.mtimeMs / 1000),
          accessTime: Math.floor(stat.atimeMs / 1000),
          permissions
        }
      } catch (e) {
        // e.g. permission denied for stat
        return null
      }
    }))

    const validFiles = files.filter(Boolean) as any[]
    
    // Sort: directories first, then alphabetical
    validFiles.sort((a, b) => {
      if (a.name === '..') return -1
      if (b.name === '..') return 1
      if (a.type === 'd' && b.type !== 'd') return -1
      if (a.type !== 'd' && b.type === 'd') return 1
      return a.name.localeCompare(b.name)
    })
    
    // Add '..' if not root
    const parentPath = path.dirname(actualPath)
    if (parentPath !== actualPath) {
       validFiles.unshift({
         name: '..',
         type: 'd',
         size: 0,
         modifyTime: 0,
         accessTime: 0,
         permissions: 'drwxr-xr-x'
       })
    }

    return validFiles
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    // upload/download for local terminal is just local file copy
    await fs.copyFile(remotePath, localPath)
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    // upload/download for local terminal is just local file copy
    await fs.copyFile(localPath, remotePath)
  }

  async move(srcPath: string, destPath: string): Promise<void> {
    await fs.rename(srcPath, destPath)
  }

  async copy(srcPath: string, destPath: string): Promise<void> {
    await fs.copyFile(srcPath, destPath)
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
