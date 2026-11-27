import { StyleSheet } from 'react-native'

export const mediaEditStyles = StyleSheet.create({
  content: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
  },
  field: {
    borderRadius: 7,
    paddingHorizontal: 8,
  },
  footer: {
    flexShrink: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontWeight: '600',
  },
})
