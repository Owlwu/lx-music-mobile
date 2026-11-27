import { Pressable, StyleSheet } from 'react-native'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'

interface MediaActionProps {
  children: string
  onPress: () => void
  kind?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
}

export default function MediaAction({ children, onPress, kind = 'secondary', disabled = false }: MediaActionProps) {
  const theme = useTheme()
  const primary = kind === 'primary'
  const color = disabled ? theme['c-650']
    : primary ? (theme.isDark ? '#171717' : '#ffffff')
      : kind === 'danger' ? (theme.isDark ? '#ffb4ab' : '#a12620') : theme['c-font']
  const backgroundColor = disabled ? theme['c-150'] : primary ? theme['c-primary-dark-500'] : 'transparent'

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.action, {
        backgroundColor,
        borderColor: primary || disabled ? backgroundColor : theme['c-350'],
        opacity: pressed ? 0.8 : 1,
      }]}
    >
      <Text size={13} color={color} style={styles.label}>{children}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  action: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  label: {
    fontWeight: '600',
    textAlign: 'center',
  },
})
