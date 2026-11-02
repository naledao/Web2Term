import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

// Build-only adapter. pe-library's declarations reference lib.dom, which must
// not change the timer types in the application's Node/main-process compilation.
export function editWindowsDevelopmentExecutable(executable, icon, productName) {
  const image = NtExecutable.from(executable, { ignoreCert: true })
  const resources = NtExecutableResource.from(image)
  const versions = Resource.VersionInfo.fromEntries(resources.entries)
  if (!versions.length) versions.push(Resource.VersionInfo.createEmpty())
  for (const version of versions) {
    const languages = version.getAllLanguagesForStringValues()
    if (!languages.length) languages.push({ lang: 0x409, codepage: 1200 })
    for (const language of languages) version.setStringValues(language, {
      ProductName: productName, FileDescription: productName, InternalName: 'electron', OriginalFilename: 'electron.exe'
    })
    version.outputToResourceEntries(resources.entries)
  }
  const icons = Data.IconFile.from(icon).icons.map(item => item.data)
  if (!icons.length) throw new Error('The Web2Term development ICO contains no images')
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries).map(({ id, lang }) => ({ id, lang }))
  if (!groups.length) groups.push({ id: 1, lang: 0x409 })
  for (const group of groups) Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons)
  resources.outputResource(image)
  return Buffer.from(image.generate())
}
