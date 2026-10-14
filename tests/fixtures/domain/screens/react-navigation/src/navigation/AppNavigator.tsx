import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import OrdersScreen from '../screens/OrdersScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function Tabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen
        name="Orders"
        component={OrdersScreen}
        options={{ title: 'My orders' }}
      />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Tabs" component={Tabs} />
      <Stack.Screen name={'OrderDetail'} component={OrderDetailScreen} />
      <Stack.Screen name="Modal">{() => <ModalScreen />}</Stack.Screen>
      {/* <Stack.Screen name="Old" component={Old} /> */}
    </Stack.Navigator>
  );
}
