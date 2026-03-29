export interface SFTPFile {
  name: string
  type: 'd' | '-' | 'l'
  size: number
  modifyTime: number
  accessTime: number
  permissions: string
}

const PARENT_DIRECTORY_PERMISSIONS = 'drwxr-xr-x'

export function createParentDirectoryEntry(): SFTPFile {
  return {
    name: '..',
    type: 'd',
    size: 0,
    modifyTime: 0,
    accessTime: 0,
    permissions: PARENT_DIRECTORY_PERMISSIONS
  }
}

export function sortSftpFiles(files: SFTPFile[]): SFTPFile[] {
  return [...files].sort((a, b) => {
    if (a.name === '..') return -1
    if (b.name === '..') return 1
    if (a.type === 'd' && b.type !== 'd') return -1
    if (a.type !== 'd' && b.type === 'd') return 1
    return a.name.localeCompare(b.name)
  })
}
